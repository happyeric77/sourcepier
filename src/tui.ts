import { Plugin } from "@opencode/plugin/tui"
import { SourcesRPC } from "./rpc.js"
import {
  parsePreview,
  parseDeletedSource,
  parseExportedSource,
  parseSavedSource,
  parseSourcesList,
  safeLabel,
  sourcesCommand,
  type PreviewSource,
} from "./view.js"
import { renderSourceViewer } from "./viewer.js"
import { renderSourceEditor } from "./editor.js"
import { draftToCanonical } from "./edit-draft.js"

function failureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message
    if (typeof message === "string") return message.slice(0, 200)
  }
  return "SourcePier request failed; check the OpenCode server log"
}

// Native TUI registration for SourcePier.
export default Plugin.define({
  id: "sourcepier.tui",
  setup(context) {
    const rpc = context.client.rpc(SourcesRPC)
    // Native TUI memory survives plugin hot reload and route changes.
    // Unpublished drafts stay in TUI memory, not canonical Source KV.
    const [drafts, updateDrafts] = context.storage.memory<{
      entries: Record<string, { source: PreviewSource; text: string }>
    }>("editor-drafts-v1", { initial: { entries: {} } })
    type Location = NonNullable<typeof context.location>

    async function importFlow(location: Location, initial?: string): Promise<void> {
      const file =
        initial?.trim() ||
        (await context.ui.dialog.prompt({
          title: "Import Markdown as Project Source",
          description: "File on the OpenCode server; absolute path or relative to this Project",
          placeholder: "~/Documents/architecture.md",
        }))
      if (!file?.trim()) return
      const confirmed = await context.ui.dialog.confirm({
        title: "Import Project Source?",
        message:
          "Copy this Markdown file into the current Project's durable Sources?\n" +
          file +
          "\n\nThe existing file stays unchanged. Duplicate Source IDs are rejected.",
        label: { confirm: "Import", cancel: "Cancel" },
      })
      if (!confirmed) return
      try {
        const result = await rpc.importMarkdown({ file }, { location })
        if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") {
          throw new Error("Unexpected import response")
        }
        context.ui.toast.show({
          title: "SourcePier",
          message: "Imported " + safeLabel(result.id) + ". All sessions in this Project can now read it.",
          variant: "success",
        })
      } catch (error) {
        context.ui.toast.show({
          title: "SourcePier",
          message: failureMessage(error),
          variant: "error",
          duration: 6000,
        })
      }
    }

    async function deleteFlow(
      source: PreviewSource,
      location: Location,
      projectID: string,
      onDeleted: () => void,
    ): Promise<void> {
      const confirmed = await context.ui.dialog.confirm({
        title: "Delete Project Source?",
        message:
          "Delete " +
          safeLabel(source.title) +
          " (" +
          source.id +
          "), revision " +
          source.revision +
          "?\n\n" +
          "This removes all saved revisions from SourcePier. There is no Restore. " +
          "The original imported Markdown file is not deleted.",
        label: { confirm: "Delete", cancel: "Cancel" },
      })
      if (!confirmed) return
      try {
        const result = parseDeletedSource(
          await rpc.deleteSource(
            { id: source.id, expectedRevision: source.revision, expectedInstance: source.instanceId },
            { location },
          ),
          source.id,
        )
        updateDrafts((state) => {
          delete state.entries[projectID + "/" + source.id]
        })
        context.ui.toast.show({
          title: "SourcePier",
          message: "Deleted " + safeLabel(source.id) + " (" + result.revisionsRemoved + " stored revisions removed)",
          variant: "success",
        })
        onDeleted()
      } catch (error) {
        context.ui.toast.show({
          title: "SourcePier: not fully deleted",
          message: failureMessage(error),
          variant: "error",
          duration: 8000,
        })
      }
    }

    async function exportFlow(source: PreviewSource, location: Location): Promise<void> {
      const path = await context.ui.dialog.prompt({
        title: "Export Source Markdown",
        description: "Choose a new .md file on the OpenCode server. Existing files are never overwritten.",
        placeholder: source.id + ".md",
      })
      if (!path?.trim()) return
      try {
        const result = parseExportedSource(await rpc.exportSource({ id: source.id, path }, { location }), source.id)
        context.ui.toast.show({
          title: "SourcePier",
          message: "Exported r" + result.revision + " to " + safeLabel(result.path, 160),
          variant: "success",
          duration: 6000,
        })
      } catch (error) {
        context.ui.toast.show({
          title: "SourcePier: export failed",
          message: failureMessage(error),
          variant: "error",
          duration: 6000,
        })
      }
    }

    // The viewer holds a read snapshot; Save/Delete use server RPCs and
    // Export writes only to a Developer-selected server-side file.
    type Viewer = {
      source: PreviewSource
      edit: () => void
      remove: () => Promise<void>
      exportMarkdown: () => Promise<void>
      back: () => void
      gone: () => void
    }
    type Editor = {
      source: PreviewSource
      save: (content: string) => Promise<{ id: string; revision: number; changed: boolean }>
      draft?: string
      onDraft: (text: string) => void
      back: () => void
      gone: () => void
    }
    let currentEditor: Editor | undefined
    let currentViewer: Viewer | undefined
    let returnRoute: ReturnType<typeof context.ui.router.current> | undefined
    const unregisterViewer = context.ui.router.register({
      name: "sources-preview",
      render: () => {
        if (!currentViewer) throw new Error("Source viewer has no active document")
        return renderSourceViewer(currentViewer)
      },
    })

    const unregisterEditor = context.ui.router.register({
      name: "sources-edit",
      render: () => {
        if (!currentEditor) throw new Error("Source editor has no active document")
        return renderSourceEditor(currentEditor)
      },
    })

    function edit(source: PreviewSource, location: Location, projectID: string): void {
      const previousRoute = returnRoute ? { ...returnRoute } : { type: "home" as const }
      const draftKey = projectID + "/" + source.id
      const recovered = drafts.entries[draftKey]
      // A recovered draft keeps its original base revision for conflict checks.
      // Do not silently rebase an unsaved draft onto a newer canonical Source.
      const baseline = recovered?.source ?? source
      if (recovered) {
        context.ui.toast.show({
          title: "SourcePier",
          message: "Recovered unsaved draft for " + safeLabel(source.id) + " (r" + baseline.revision + ")",
          variant: "info",
        })
      }
      let settled = false
      let saveRequested = false
      const current: Editor = {
        source: baseline,
        draft: recovered?.text,
        onDraft: (text) => {
          if (settled) return
          const changed = draftToCanonical(baseline.content, text).changed
          updateDrafts((state) => {
            // After Save/recovery, baseline text can still be an unpublished undo.
            if (changed || saveRequested || recovered) state.entries[draftKey] = { source: baseline, text }
            else delete state.entries[draftKey]
          })
        },
        save: async (content) => {
          saveRequested = true
          const result = parseSavedSource(
            await rpc.saveSource(
              { id: baseline.id, expectedRevision: baseline.revision, expectedInstance: baseline.instanceId, content },
              { location },
            ),
            baseline.id,
          )
          // If navigation happened during Save, don't retain an already-saved
          // draft. But never clear edits made while the request was in flight.
          updateDrafts((state) => {
            const entry = state.entries[draftKey]
            if (entry && draftToCanonical(entry.source.content, entry.text).content === content) {
              delete state.entries[draftKey]
            }
          })
          return result
        },
        back: () => {
          if (settled) return
          settled = true
          updateDrafts((state) => {
            delete state.entries[draftKey]
          })
          if (currentEditor === current) currentEditor = undefined
          context.ui.router.navigate(previousRoute)
          // Refresh the canonical list after an explicit Save or Discard.
          setTimeout(() => void browse(location), 0)
        },
        gone: () => {
          if (settled) return
          settled = true
          if (currentEditor === current) currentEditor = undefined
          // External navigation / plugin reload: retain the unsaved draft.
        },
      }
      currentEditor = current
      context.ui.router.navigate({ type: "plugin", name: "sources-edit", data: { id: source.id } })
    }

    async function preview(source: PreviewSource, location: Location, projectID: string): Promise<boolean> {
      const previousRoute = { ...context.ui.router.current() }
      returnRoute = previousRoute
      return new Promise<boolean>((resolve) => {
        let settled = false
        const current: Viewer = {
          source,
          edit: () => edit(source, location, projectID),
          remove: () => deleteFlow(source, location, projectID, () => current.back()),
          exportMarkdown: () => exportFlow(source, location),
          back: () => {
            if (settled) return
            settled = true
            if (currentViewer === current) currentViewer = undefined
            context.ui.router.navigate(previousRoute)
            // Allow the previous route to mount before reopening its native list.
            setTimeout(() => resolve(true), 0)
          },
          gone: () => {
            if (settled) return
            settled = true
            if (currentViewer === current) currentViewer = undefined
            resolve(false)
          },
        }
        currentViewer = current
        context.ui.router.navigate({ type: "plugin", name: "sources-preview", data: { id: source.id } })
      })
    }

    async function browse(location: Location): Promise<void> {
      while (true) {
        let projectID: string
        let items: ReturnType<typeof parseSourcesList>
        try {
          projectID = (await context.client.location.get({ location })).project.id
          items = parseSourcesList(await rpc.listSources({}, { location }))
        } catch (error) {
          context.ui.toast.show({ title: "SourcePier", message: failureMessage(error), variant: "error" })
          return
        }
        const options = [
          { title: "+ Add / Import Markdown", description: "Copy a file into this Project", value: "action:add" },
          { title: "↻ Refresh Sources", description: "Reload the latest Source index", value: "action:refresh" },
          ...items.sources
            .slice()
            .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
            .map((source) => ({
              title:
                source.id +
                " · " +
                source.format +
                " · r" +
                source.revision +
                " · " +
                (safeLabel(source.title) || source.id) +
                (drafts.entries[projectID + "/" + source.id] ? " · Unsaved draft" : ""),
              description: safeLabel(source.description ?? "", 160),
              value: source.id,
            })),
        ]
        if (items.truncated) {
          options.push({
            title: "More Sources exist (showing first 100)",
            description: "Agent list uses the same bounded index",
            value: "action:limit",
          })
        }
        const selection = await context.ui.dialog.select({
          title: "SourcePier (" + items.sources.length + (items.truncated ? "+" : "") + ")",
          placeholder: "Search and select a Source to preview",
          options,
        })
        if (selection === undefined) return
        if (selection === "action:refresh" || selection === "action:limit") continue
        if (selection === "action:add") {
          await importFlow(location)
          continue
        }
        try {
          const source = parsePreview(await rpc.readSource({ id: selection }, { location }), selection)
          // Reuse canonical reads; TUI also receives incarnation identity.
          if (!(await preview(source, location, projectID))) return
        } catch (error) {
          context.ui.toast.show({
            title: "SourcePier",
            message: failureMessage(error),
            variant: "error",
            duration: 6000,
          })
        }
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "sourcepier.browse",
          title: "Browse Sources",
          group: "SourcePier",
          palette: true,
          slash: { name: "sources", arguments: true },
          run: async (input) => {
            const location = context.location ?? context.data.location.default()
            const command = sourcesCommand(input)
            if (command.mode === "add") return importFlow(location, command.file)
            return browse(location)
          },
        },
        {
          id: "sourcepier.import",
          title: "Import Project Source",
          group: "SourcePier",
          palette: true,
          run: async () => {
            const location = context.location ?? context.data.location.default()
            await importFlow(location)
          },
        },
      ],
    }))
    return () => {
      currentViewer?.gone()
      currentEditor?.gone()
      const route = context.ui.router.current()
      if (
        returnRoute &&
        route.type === "plugin" &&
        (route.name === "sources-preview" || route.name === "sources-edit")
      ) {
        context.ui.router.navigate(returnRoute)
      }
      unregisterEditor()
      unregisterViewer()
    }
  },
})
