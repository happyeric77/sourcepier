import { createSignal, onCleanup } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core"
import type { PreviewSource } from "./view.js"
import { safeLabel } from "./view.js"

/**
 * Full-screen Markdown preview of the current canonical Source.
 * Delete, Edit and Export actions are handled by separate RPC flows.
 */
export function renderSourceViewer(props: {
  source: PreviewSource
  edit: () => void
  remove: () => Promise<void>
  exportMarkdown: () => Promise<void>
  back: () => void
  gone: () => void
}) {
  return <SourceViewer {...props} />
}

function SourceViewer(props: {
  source: PreviewSource
  edit: () => void
  remove: () => Promise<void>
  exportMarkdown: () => Promise<void>
  back: () => void
  gone: () => void
}) {
  const context = usePlugin()
  const [modal, setModal] = createSignal(false)
  async function action(run: () => Promise<void>) {
    if (modal()) return
    setModal(true)
    try {
      await run()
    } finally {
      setModal(false)
    }
  }
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: context.theme.text.base },
    "markup.heading": { fg: context.theme.text.base, bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: context.theme.text.muted },
  })
  onCleanup(() => syntaxStyle.destroy())
  let scroll: ScrollBoxRenderable | undefined
  onCleanup(props.gone)

  context.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    enabled: () => {
      const route = context.ui.router.current()
      return route.type === "plugin" && route.name === "sources-preview" && !modal()
    },
    commands: [
      { id: "sourcepier.preview.back", bind: "escape", title: "Back to Sources", run: props.back },
      {
        id: "sourcepier.preview.edit",
        bind: "e",
        title: "Edit Source",
        enabled: () => props.source.format === "markdown",
        run: props.edit,
      },
      { id: "sourcepier.preview.delete", bind: "d", title: "Delete Source", run: () => action(props.remove) },
      {
        id: "sourcepier.preview.export",
        bind: "x",
        title: "Export Source Markdown",
        enabled: () => props.source.format === "markdown",
        run: () => action(props.exportMarkdown),
      },
      { id: "sourcepier.preview.down", bind: "down,j", title: "Scroll down", run: () => scroll?.scrollBy(2) },
      { id: "sourcepier.preview.up", bind: "up,k", title: "Scroll up", run: () => scroll?.scrollBy(-2) },
      {
        id: "sourcepier.preview.page-down",
        bind: "pagedown",
        title: "Page down",
        run: () => scroll?.scrollBy(Math.max(1, scroll.viewport.height - 2)),
      },
      {
        id: "sourcepier.preview.page-up",
        bind: "pageup",
        title: "Page up",
        run: () => scroll?.scrollBy(-Math.max(1, scroll.viewport.height - 2)),
      },
      { id: "sourcepier.preview.top", bind: "home", title: "Start of document", run: () => scroll?.scrollTo(0) },
      {
        id: "sourcepier.preview.bottom",
        bind: "end",
        title: "End of document",
        run: () => scroll?.scrollTo(scroll.scrollHeight),
      },
    ],
  }))

  const heading =
    safeLabel(props.source.title, Math.max(12, Math.min(56, context.renderer.width - 30))) || props.source.id

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingTop={1} paddingBottom={1}>
        <text fg={context.theme.text.base}>SourcePier / {heading}</text>
        <text fg={context.theme.text.muted}>
          r{props.source.revision} · {props.source.format}
        </text>
      </box>
      <box flexGrow={1} minHeight={0}>
        <scrollbox
          ref={(node) => {
            scroll = node
          }}
          flexGrow={1}
          viewportOptions={{ paddingRight: 1 }}
          stickyScroll={false}
          verticalScrollbarOptions={{ visible: true }}
        >
          <box paddingLeft={1} paddingRight={1} flexDirection="column">
            <markdown
              syntaxStyle={syntaxStyle}
              content={props.source.content}
              tableOptions={{ style: "grid", cellPaddingX: 1 }}
              fg={context.theme.text.base}
              bg={context.theme.background.base}
            />
          </box>
        </scrollbox>
      </box>
      <box flexShrink={0} paddingTop={1} paddingBottom={1}>
        <text fg={context.theme.text.muted}>
          {props.source.format === "markdown" ? "e Edit · x Export · " : ""}d Delete · ↑↓ Scroll · Esc Back
        </text>
      </box>
    </box>
  )
}
