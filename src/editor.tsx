import { createSignal, onCleanup } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import type { TextareaRenderable } from "@opentui/core"
import type { PreviewSource } from "./view.js"
import { draftToCanonical, editorInitialValue } from "./edit-draft.js"
import { safeLabel } from "./view.js"

export function renderSourceEditor(props: {
  source: PreviewSource
  save: (content: string) => Promise<{ id: string; revision: number; changed: boolean }>
  back: () => void
  gone: () => void
  draft?: string
  onDraft: (text: string) => void
}) {
  return <SourceEditor {...props} />
}

function SourceEditor(props: {
  source: PreviewSource
  save: (content: string) => Promise<{ id: string; revision: number; changed: boolean }>
  back: () => void
  gone: () => void
  draft?: string
  onDraft: (text: string) => void
}) {
  const context = usePlugin()
  const baseline = editorInitialValue(props.source.content)
  let textarea: TextareaRenderable | undefined
  let saving = false
  let disposed = false
  let confirmingDiscard = false
  const initial = props.draft ?? baseline
  const [draft, setDraft] = createSignal(initial)
  const [conflict, setConflict] = createSignal(false)
  onCleanup(() => {
    disposed = true
    props.gone()
  })

  const dirty = () => draftToCanonical(props.source.content, draft()).changed || props.draft !== undefined || conflict()

  async function discard() {
    if (saving) return
    if (dirty()) {
      if (confirmingDiscard) return
      confirmingDiscard = true
      let confirmed: boolean | undefined
      try {
        confirmed = await context.ui.dialog.confirm({
          title: "Discard changes?",
          message: "This unsaved draft will be lost. The canonical Source is unchanged.",
          label: { confirm: "Discard", cancel: "Keep editing" },
        })
      } finally {
        confirmingDiscard = false
      }
      if (!confirmed) return
    }
    props.back()
  }

  async function save() {
    if (saving) return
    // plainText is authoritative; input events update draft immediately,
    // including pasted Unicode and native newline normalization.
    const submittedText = textarea?.plainText ?? draft()
    const canonical = draftToCanonical(props.source.content, submittedText)
    if (!canonical.changed && props.draft === undefined && !conflict()) {
      context.ui.toast.show({ title: "SourcePier", message: "No changes to save", variant: "success" })
      props.back()
      return
    }
    saving = true
    try {
      const saved = await props.save(canonical.content)
      if (disposed) return
      // A user may have kept typing while an asynchronous Save was running.
      // Never discard text that wasn't included in the published revision.
      if ((textarea?.plainText ?? draft()) !== submittedText) {
        setConflict(true)
        context.ui.toast.show({
          title: "SourcePier",
          message: "Saved r" + saved.revision + "; later edits remain in this draft. Reopen to resolve revisions.",
          variant: "warning",
          duration: 8000,
        })
        return
      }
      context.ui.toast.show({
        title: "SourcePier",
        message: "Saved " + safeLabel(props.source.id) + " revision " + saved.revision,
        variant: "success",
      })
      props.back()
    } catch (error) {
      if (disposed) return
      const message =
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message.slice(0, 200)
          : "Save failed; draft retained"
      if (/revision_conflict|newer revision|conflict/i.test(message)) setConflict(true)
      context.ui.toast.show({ title: "SourcePier: not saved", message, variant: "error", duration: 8000 })
      // Never discard the draft or retry using a newer expected revision.
    } finally {
      saving = false
    }
  }

  context.keymap.layer(() => ({
    mode: "global",
    priority: 110,
    enabled: () => {
      const route = context.ui.router.current()
      return !confirmingDiscard && route.type === "plugin" && route.name === "sources-edit"
    },
    commands: [
      { id: "sourcepier.editor.save", bind: "ctrl+s", title: "Save Source revision", run: save },
      { id: "sourcepier.editor.back", bind: "escape", title: "Discard/Back to Sources", run: discard },
    ],
  }))

  const title =
    safeLabel(props.source.title, Math.max(12, Math.min(54, context.renderer.width - 28))) || props.source.id
  return (
    <box width="100%" height="100%" paddingLeft={1} paddingRight={1} flexDirection="column">
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingTop={1} paddingBottom={1}>
        <text fg={context.theme.text.base}>Edit Source / {title}</text>
        <text fg={context.theme.text.muted}>
          r{props.source.revision}
          {dirty() ? " *" : ""}
        </text>
      </box>
      <box flexGrow={1} minHeight={0}>
        <textarea
          width="100%"
          height="100%"
          initialValue={initial}
          textColor={context.theme.text.base}
          focusedTextColor={context.theme.text.base}
          placeholder="Edit Markdown…"
          onContentChange={() => {
            const value = textarea?.plainText ?? initial
            setDraft(value)
            props.onDraft(value)
          }}
          ref={(node: TextareaRenderable) => {
            textarea = node
            node.focus()
          }}
        />
      </box>
      <box flexShrink={0} paddingTop={1} paddingBottom={1}>
        <text fg={conflict() ? context.theme.text.base : context.theme.text.muted}>
          {conflict()
            ? "Conflict: latest Source changed · draft retained · Esc to discard"
            : "Ctrl+S Save  ·  Esc Back/Discard"}
        </text>
      </box>
    </box>
  )
}
