// @bun
// src/tui.ts
import { Plugin } from "@opencode/plugin/tui";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var emptyError = { type: "object", properties: {}, additionalProperties: false };
var sourceProperties = {
  id: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  format: { type: "string", enum: ["markdown", "text"] },
  revision: { type: "integer" }
};
var sourceSummary = {
  type: "object",
  properties: sourceProperties,
  required: ["id", "title", "format", "revision"],
  additionalProperties: false
};
var readErrors = {
  project_unresolved: emptyError,
  source_not_found: emptyError,
  invalid_source_id: emptyError,
  source_unavailable: emptyError,
  storage_unavailable: emptyError
};
var SourcesRPC = Rpc.define({
  id: "sourcepier",
  methods: {
    importMarkdown: {
      input: {
        type: "object",
        properties: { file: { type: "string", minLength: 1 } },
        required: ["file"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          revision: { type: "integer" }
        },
        required: ["id", "title", "revision"],
        additionalProperties: false
      },
      errors: {
        invalid_path: emptyError,
        invalid_markdown: emptyError,
        already_exists: emptyError,
        storage_unavailable: emptyError,
        project_unresolved: emptyError
      }
    },
    listSources: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          sources: { type: "array", items: sourceSummary },
          truncated: { type: "boolean" }
        },
        required: ["sources", "truncated"],
        additionalProperties: false
      },
      errors: readErrors
    },
    saveSource: {
      input: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          expectedRevision: { type: "integer", minimum: 1 },
          expectedInstance: { type: "string", minLength: 1 },
          content: { type: "string" }
        },
        required: ["id", "expectedRevision", "expectedInstance", "content"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          revision: { type: "integer" },
          changed: { type: "boolean" }
        },
        required: ["id", "revision", "changed"],
        additionalProperties: false
      },
      errors: {
        invalid_source_id: emptyError,
        invalid_content: emptyError,
        source_not_found: emptyError,
        source_unavailable: emptyError,
        project_unresolved: emptyError,
        revision_conflict: emptyError,
        revision_exhausted: emptyError,
        publication_blocked: emptyError,
        writer_busy: emptyError,
        writer_unavailable: emptyError,
        storage_unavailable: emptyError
      }
    },
    deleteSource: {
      input: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          expectedRevision: { type: "integer", minimum: 1 },
          expectedInstance: { type: "string", minLength: 1 }
        },
        required: ["id", "expectedRevision", "expectedInstance"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          deleted: { type: "boolean" },
          revisionsRemoved: { type: "integer" }
        },
        required: ["id", "deleted", "revisionsRemoved"],
        additionalProperties: false
      },
      errors: {
        invalid_source_id: emptyError,
        project_unresolved: emptyError,
        source_not_found: emptyError,
        source_unavailable: emptyError,
        revision_conflict: emptyError,
        cleanup_incomplete: emptyError,
        storage_unavailable: emptyError,
        writer_busy: emptyError,
        writer_unavailable: emptyError
      }
    },
    exportSource: {
      input: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 }
        },
        required: ["id", "path"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          revision: { type: "integer" },
          bytes: { type: "integer" }
        },
        required: ["id", "path", "revision", "bytes"],
        additionalProperties: false
      },
      errors: {
        invalid_source_id: emptyError,
        project_unresolved: emptyError,
        source_not_found: emptyError,
        source_unavailable: emptyError,
        invalid_path: emptyError,
        already_exists: emptyError,
        write_failed: emptyError,
        storage_unavailable: emptyError
      }
    },
    readSource: {
      input: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { ...sourceProperties, content: { type: "string" }, instanceId: { type: "string", minLength: 1 } },
        required: ["id", "title", "format", "revision", "content", "instanceId"],
        additionalProperties: false
      },
      errors: readErrors
    }
  },
  events: {}
});

// src/view.ts
function sourcesCommand(raw) {
  const input = (raw ?? "").trim();
  if (!input || input === "browse" || input === "list")
    return { mode: "browse" };
  if (input === "add" || input === "import")
    return { mode: "add" };
  const path = input.startsWith("add ") ? input.slice(4).trim() : input.startsWith("import ") ? input.slice(7).trim() : input;
  if (path.length >= 2 && (path.startsWith('"') && path.endsWith('"') || path.startsWith("'") && path.endsWith("'"))) {
    return { mode: "add", file: path.slice(1, -1) };
  }
  return { mode: "add", file: path || undefined };
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sourceInfo(value) {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || !Number.isSafeInteger(value.revision) || value.format !== "markdown" && value.format !== "text" || value.description !== undefined && typeof value.description !== "string") {
    throw new Error("Invalid Sources response");
  }
  return {
    id: value.id,
    title: value.title,
    revision: value.revision,
    format: value.format,
    ...value.description === undefined ? {} : { description: value.description }
  };
}
function parseSourcesList(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.sources) || typeof raw.truncated !== "boolean") {
    throw new Error("Invalid Sources list response");
  }
  return { sources: raw.sources.map(sourceInfo), truncated: raw.truncated };
}
function parsePreview(raw, expectedID) {
  const info = sourceInfo(raw);
  if (info.id !== expectedID || !isRecord(raw) || typeof raw.content !== "string" || typeof raw.instanceId !== "string" || !raw.instanceId) {
    throw new Error("Invalid Sources preview response");
  }
  return { ...info, content: raw.content, instanceId: raw.instanceId };
}
function parseSavedSource(raw, expectedID) {
  if (!isRecord(raw) || raw.id !== expectedID || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || raw.revision > 999999 || typeof raw.changed !== "boolean")
    throw new Error("Invalid Source Save response; reload before retrying");
  return { id: expectedID, revision: raw.revision, changed: raw.changed };
}
function parseDeletedSource(raw, expectedID) {
  if (!isRecord(raw) || raw.id !== expectedID || raw.deleted !== true || typeof raw.revisionsRemoved !== "number" || !Number.isSafeInteger(raw.revisionsRemoved) || raw.revisionsRemoved < 0)
    throw new Error("Invalid Source Delete response; refresh Sources");
  return { id: expectedID, revisionsRemoved: raw.revisionsRemoved };
}
function parseExportedSource(raw, expectedID) {
  if (!isRecord(raw) || raw.id !== expectedID || typeof raw.path !== "string" || !raw.path || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || raw.revision > 999999 || typeof raw.bytes !== "number" || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0)
    throw new Error("Invalid Source Export response; verify output file");
  return { id: expectedID, path: raw.path, revision: raw.revision, bytes: raw.bytes };
}
function safeLabel(value, length = 100) {
  return Array.from(value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim()).slice(0, length).join("");
}

// src/viewer.tsx
import { effect as _$effect } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import { usePlugin } from "@opencode/plugin/tui";
import { SyntaxStyle } from "@opentui/core";
function renderSourceViewer(props) {
  return _$createComponent(SourceViewer, props);
}
function SourceViewer(props) {
  const context = usePlugin();
  const [modal, setModal] = createSignal(false);
  async function action(run) {
    if (modal())
      return;
    setModal(true);
    try {
      await run();
    } finally {
      setModal(false);
    }
  }
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: {
      fg: context.theme.text.base
    },
    "markup.heading": {
      fg: context.theme.text.base,
      bold: true
    },
    "markup.strong": {
      bold: true
    },
    "markup.italic": {
      italic: true
    },
    "markup.raw": {
      fg: context.theme.text.muted
    }
  }, context.renderer.nativeScene);
  onCleanup(() => context.renderer.idle().then(() => syntaxStyle.destroy()));
  let scroll;
  onCleanup(props.gone);
  context.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    enabled: () => {
      const route = context.ui.router.current();
      return route.type === "plugin" && route.name === "sources-preview" && !modal();
    },
    commands: [{
      id: "sourcepier.preview.back",
      bind: "escape",
      title: "Back to Sources",
      run: props.back
    }, {
      id: "sourcepier.preview.edit",
      bind: "e",
      title: "Edit Source",
      enabled: () => props.source.format === "markdown",
      run: props.edit
    }, {
      id: "sourcepier.preview.delete",
      bind: "d",
      title: "Delete Source",
      run: () => action(props.remove)
    }, {
      id: "sourcepier.preview.export",
      bind: "x",
      title: "Export Source Markdown",
      enabled: () => props.source.format === "markdown",
      run: () => action(props.exportMarkdown)
    }, {
      id: "sourcepier.preview.down",
      bind: "down,j",
      title: "Scroll down",
      run: () => scroll?.scrollBy(2)
    }, {
      id: "sourcepier.preview.up",
      bind: "up,k",
      title: "Scroll up",
      run: () => scroll?.scrollBy(-2)
    }, {
      id: "sourcepier.preview.page-down",
      bind: "pagedown",
      title: "Page down",
      run: () => scroll?.scrollBy(Math.max(1, scroll.viewport.height - 2))
    }, {
      id: "sourcepier.preview.page-up",
      bind: "pageup",
      title: "Page up",
      run: () => scroll?.scrollBy(-Math.max(1, scroll.viewport.height - 2))
    }, {
      id: "sourcepier.preview.top",
      bind: "home",
      title: "Start of document",
      run: () => scroll?.scrollTo(0)
    }, {
      id: "sourcepier.preview.bottom",
      bind: "end",
      title: "End of document",
      run: () => scroll?.scrollTo(scroll.scrollHeight)
    }]
  }));
  const heading = safeLabel(props.source.title, Math.max(12, Math.min(56, context.renderer.width - 30))) || props.source.id;
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createTextNode(`SourcePier / `), _el$5 = _$createElement("text"), _el$6 = _$createTextNode(`r`), _el$7 = _$createTextNode(` \xB7 `), _el$8 = _$createElement("box"), _el$9 = _$createElement("scrollbox"), _el$0 = _$createElement("box"), _el$1 = _$createElement("markdown"), _el$10 = _$createElement("box"), _el$11 = _$createElement("text"), _el$12 = _$createTextNode(`d Delete \xB7 \u2191\u2193 Scroll \xB7 Esc Back`);
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$8);
    _$insertNode(_el$, _el$10);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "height", "100%");
    _$setProp(_el$, "paddingLeft", 1);
    _$setProp(_el$, "paddingRight", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$5);
    _$setProp(_el$2, "flexShrink", 0);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "justifyContent", "space-between");
    _$setProp(_el$2, "paddingTop", 1);
    _$setProp(_el$2, "paddingBottom", 1);
    _$insertNode(_el$3, _el$4);
    _$insert(_el$3, heading, null);
    _$insertNode(_el$5, _el$6);
    _$insertNode(_el$5, _el$7);
    _$insert(_el$5, () => props.source.revision, _el$7);
    _$insert(_el$5, () => props.source.format, null);
    _$insertNode(_el$8, _el$9);
    _$setProp(_el$8, "flexGrow", 1);
    _$setProp(_el$8, "minHeight", 0);
    _$insertNode(_el$9, _el$0);
    _$use((node) => {
      scroll = node;
    }, _el$9);
    _$setProp(_el$9, "flexGrow", 1);
    _$setProp(_el$9, "viewportOptions", {
      paddingRight: 1
    });
    _$setProp(_el$9, "stickyScroll", false);
    _$setProp(_el$9, "verticalScrollbarOptions", {
      visible: true
    });
    _$insertNode(_el$0, _el$1);
    _$setProp(_el$0, "paddingLeft", 1);
    _$setProp(_el$0, "paddingRight", 1);
    _$setProp(_el$0, "flexDirection", "column");
    _$setProp(_el$1, "syntaxStyle", syntaxStyle);
    _$setProp(_el$1, "tableOptions", {
      style: "grid",
      cellPaddingX: 1
    });
    _$insertNode(_el$10, _el$11);
    _$setProp(_el$10, "flexShrink", 0);
    _$setProp(_el$10, "paddingTop", 1);
    _$setProp(_el$10, "paddingBottom", 1);
    _$insertNode(_el$11, _el$12);
    _$insert(_el$11, () => props.source.format === "markdown" ? "e Edit \xB7 x Export \xB7 " : "", _el$12);
    _$effect((_p$) => {
      var _v$ = context.theme.text.base, _v$2 = context.theme.text.muted, _v$3 = props.source.content, _v$4 = context.theme.text.base, _v$5 = context.theme.background.base, _v$6 = context.theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$1, "content", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$1, "fg", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$1, "bg", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$11, "fg", _v$6, _p$.n));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined
    });
    return _el$;
  })();
}

// src/editor.tsx
import { effect as _$effect2 } from "@opentui/solid";
import { use as _$use2 } from "@opentui/solid";
import { memo as _$memo2 } from "@opentui/solid";
import { insert as _$insert2 } from "@opentui/solid";
import { createTextNode as _$createTextNode2 } from "@opentui/solid";
import { insertNode as _$insertNode2 } from "@opentui/solid";
import { setProp as _$setProp2 } from "@opentui/solid";
import { createElement as _$createElement2 } from "@opentui/solid";
import { createComponent as _$createComponent2 } from "@opentui/solid";
import { createSignal as createSignal2, onCleanup as onCleanup2 } from "solid-js";
import { usePlugin as usePlugin2 } from "@opencode/plugin/tui";

// src/edit-draft.ts
function editorInitialValue(original) {
  return original.replace(/^\uFEFF/, "").replace(/\r\n?/g, `
`);
}
function draftToCanonical(original, draft) {
  const plain = editorInitialValue(original);
  if (draft === plain)
    return { content: original, changed: false };
  const body = draft.replace(/\r\n?/g, `
`);
  const withoutBOM = original.replace(/^\uFEFF/, "");
  const crlfOnly = withoutBOM.includes(`\r
`) && !withoutBOM.replace(/\r\n/g, "").includes(`
`) && !withoutBOM.replace(/\r\n/g, "").includes("\r");
  return {
    content: (original.startsWith("\uFEFF") ? "\uFEFF" : "") + (crlfOnly ? body.replace(/\n/g, `\r
`) : body),
    changed: true
  };
}

// src/editor.tsx
function renderSourceEditor(props) {
  return _$createComponent2(SourceEditor, props);
}
function SourceEditor(props) {
  const context = usePlugin2();
  const baseline = editorInitialValue(props.source.content);
  let textarea;
  let saving = false;
  let disposed = false;
  let confirmingDiscard = false;
  const initial = props.draft ?? baseline;
  const [draft, setDraft] = createSignal2(initial);
  const [conflict, setConflict] = createSignal2(false);
  onCleanup2(() => {
    disposed = true;
    props.gone();
  });
  const dirty = () => draftToCanonical(props.source.content, draft()).changed || props.draft !== undefined || conflict();
  async function discard() {
    if (saving)
      return;
    if (dirty()) {
      if (confirmingDiscard)
        return;
      confirmingDiscard = true;
      let confirmed;
      try {
        confirmed = await context.ui.dialog.confirm({
          title: "Discard changes?",
          message: "This unsaved draft will be lost. The canonical Source is unchanged.",
          label: {
            confirm: "Discard",
            cancel: "Keep editing"
          }
        });
      } finally {
        confirmingDiscard = false;
      }
      if (!confirmed)
        return;
    }
    props.back();
  }
  async function save() {
    if (saving)
      return;
    const submittedText = textarea?.plainText ?? draft();
    const canonical = draftToCanonical(props.source.content, submittedText);
    if (!canonical.changed && props.draft === undefined && !conflict()) {
      context.ui.toast.show({
        title: "SourcePier",
        message: "No changes to save",
        variant: "success"
      });
      props.back();
      return;
    }
    saving = true;
    try {
      const saved = await props.save(canonical.content);
      if (disposed)
        return;
      if ((textarea?.plainText ?? draft()) !== submittedText) {
        setConflict(true);
        context.ui.toast.show({
          title: "SourcePier",
          message: "Saved r" + saved.revision + "; later edits remain in this draft. Reopen to resolve revisions.",
          variant: "warning",
          duration: 8000
        });
        return;
      }
      context.ui.toast.show({
        title: "SourcePier",
        message: "Saved " + safeLabel(props.source.id) + " revision " + saved.revision,
        variant: "success"
      });
      props.back();
    } catch (error) {
      if (disposed)
        return;
      const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message.slice(0, 200) : "Save failed; draft retained";
      if (/revision_conflict|newer revision|conflict/i.test(message))
        setConflict(true);
      context.ui.toast.show({
        title: "SourcePier: not saved",
        message,
        variant: "error",
        duration: 8000
      });
    } finally {
      saving = false;
    }
  }
  context.keymap.layer(() => ({
    mode: "global",
    priority: 110,
    enabled: () => {
      const route = context.ui.router.current();
      return !confirmingDiscard && route.type === "plugin" && route.name === "sources-edit";
    },
    commands: [{
      id: "sourcepier.editor.save",
      bind: "ctrl+s",
      title: "Save Source revision",
      run: save
    }, {
      id: "sourcepier.editor.back",
      bind: "escape",
      title: "Discard/Back to Sources",
      run: discard
    }]
  }));
  const title = safeLabel(props.source.title, Math.max(12, Math.min(54, context.renderer.width - 28))) || props.source.id;
  return (() => {
    var _el$ = _$createElement2("box"), _el$2 = _$createElement2("box"), _el$3 = _$createElement2("text"), _el$4 = _$createTextNode2(`Edit Source / `), _el$5 = _$createElement2("text"), _el$6 = _$createTextNode2(`r`), _el$7 = _$createElement2("box"), _el$8 = _$createElement2("textarea"), _el$9 = _$createElement2("box"), _el$0 = _$createElement2("text");
    _$insertNode2(_el$, _el$2);
    _$insertNode2(_el$, _el$7);
    _$insertNode2(_el$, _el$9);
    _$setProp2(_el$, "width", "100%");
    _$setProp2(_el$, "height", "100%");
    _$setProp2(_el$, "paddingLeft", 1);
    _$setProp2(_el$, "paddingRight", 1);
    _$setProp2(_el$, "flexDirection", "column");
    _$insertNode2(_el$2, _el$3);
    _$insertNode2(_el$2, _el$5);
    _$setProp2(_el$2, "flexShrink", 0);
    _$setProp2(_el$2, "flexDirection", "row");
    _$setProp2(_el$2, "justifyContent", "space-between");
    _$setProp2(_el$2, "paddingTop", 1);
    _$setProp2(_el$2, "paddingBottom", 1);
    _$insertNode2(_el$3, _el$4);
    _$insert2(_el$3, title, null);
    _$insertNode2(_el$5, _el$6);
    _$insert2(_el$5, () => props.source.revision, null);
    _$insert2(_el$5, () => dirty() ? " *" : "", null);
    _$insertNode2(_el$7, _el$8);
    _$setProp2(_el$7, "flexGrow", 1);
    _$setProp2(_el$7, "minHeight", 0);
    _$use2((node) => {
      textarea = node;
      node.focus();
    }, _el$8);
    _$setProp2(_el$8, "width", "100%");
    _$setProp2(_el$8, "height", "100%");
    _$setProp2(_el$8, "initialValue", initial);
    _$setProp2(_el$8, "placeholder", "Edit Markdown\u2026");
    _$setProp2(_el$8, "onContentChange", () => {
      const value = textarea?.plainText ?? initial;
      setDraft(value);
      props.onDraft(value);
    });
    _$insertNode2(_el$9, _el$0);
    _$setProp2(_el$9, "flexShrink", 0);
    _$setProp2(_el$9, "paddingTop", 1);
    _$setProp2(_el$9, "paddingBottom", 1);
    _$insert2(_el$0, () => conflict() ? "Conflict: latest Source changed \xB7 draft retained \xB7 Esc to discard" : "Ctrl+S Save  \xB7  Esc Back/Discard");
    _$effect2((_p$) => {
      var _v$ = context.theme.text.base, _v$2 = context.theme.text.muted, _v$3 = context.theme.text.base, _v$4 = context.theme.text.base, _v$5 = conflict() ? context.theme.text.base : context.theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp2(_el$3, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp2(_el$5, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp2(_el$8, "textColor", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp2(_el$8, "focusedTextColor", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp2(_el$0, "fg", _v$5, _p$.i));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined
    });
    return _el$;
  })();
}

// src/tui.ts
function failureMessage(error) {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string")
      return message.slice(0, 200);
  }
  return "SourcePier request failed; check the OpenCode server log";
}
var tui_default = Plugin.define({
  id: "sourcepier.tui",
  setup(context) {
    const rpc = context.client.rpc(SourcesRPC);
    const [drafts, updateDrafts] = context.storage.memory("editor-drafts-v1", { initial: { entries: {} } });
    async function importFlow(location, initial) {
      const file = initial?.trim() || await context.ui.dialog.prompt({
        title: "Import Markdown as Project Source",
        description: "File on the OpenCode server; absolute path or relative to this Project",
        placeholder: "~/Documents/architecture.md"
      });
      if (!file?.trim())
        return;
      const confirmed = await context.ui.dialog.confirm({
        title: "Import Project Source?",
        message: `Copy this Markdown file into the current Project's durable Sources?
` + file + `

The existing file stays unchanged. Duplicate Source IDs are rejected.`,
        label: { confirm: "Import", cancel: "Cancel" }
      });
      if (!confirmed)
        return;
      try {
        const result = await rpc.importMarkdown({ file }, { location });
        if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") {
          throw new Error("Unexpected import response");
        }
        context.ui.toast.show({
          title: "SourcePier",
          message: "Imported " + safeLabel(result.id) + ". All sessions in this Project can now read it.",
          variant: "success"
        });
      } catch (error) {
        context.ui.toast.show({
          title: "SourcePier",
          message: failureMessage(error),
          variant: "error",
          duration: 6000
        });
      }
    }
    async function deleteFlow(source, location, projectID, onDeleted) {
      const confirmed = await context.ui.dialog.confirm({
        title: "Delete Project Source?",
        message: "Delete " + safeLabel(source.title) + " (" + source.id + "), revision " + source.revision + `?

` + "This removes all saved revisions from SourcePier. There is no Restore. " + "The original imported Markdown file is not deleted.",
        label: { confirm: "Delete", cancel: "Cancel" }
      });
      if (!confirmed)
        return;
      try {
        const result = parseDeletedSource(await rpc.deleteSource({ id: source.id, expectedRevision: source.revision, expectedInstance: source.instanceId }, { location }), source.id);
        updateDrafts((state) => {
          delete state.entries[projectID + "/" + source.id];
        });
        context.ui.toast.show({
          title: "SourcePier",
          message: "Deleted " + safeLabel(source.id) + " (" + result.revisionsRemoved + " stored revisions removed)",
          variant: "success"
        });
        onDeleted();
      } catch (error) {
        context.ui.toast.show({
          title: "SourcePier: not fully deleted",
          message: failureMessage(error),
          variant: "error",
          duration: 8000
        });
      }
    }
    async function exportFlow(source, location) {
      const path = await context.ui.dialog.prompt({
        title: "Export Source Markdown",
        description: "Choose a new .md file on the OpenCode server. Existing files are never overwritten.",
        placeholder: source.id + ".md"
      });
      if (!path?.trim())
        return;
      try {
        const result = parseExportedSource(await rpc.exportSource({ id: source.id, path }, { location }), source.id);
        context.ui.toast.show({
          title: "SourcePier",
          message: "Exported r" + result.revision + " to " + safeLabel(result.path, 160),
          variant: "success",
          duration: 6000
        });
      } catch (error) {
        context.ui.toast.show({
          title: "SourcePier: export failed",
          message: failureMessage(error),
          variant: "error",
          duration: 6000
        });
      }
    }
    let currentEditor;
    let currentViewer;
    let returnRoute;
    const unregisterViewer = context.ui.router.register({
      name: "sources-preview",
      render: () => {
        if (!currentViewer)
          throw new Error("Source viewer has no active document");
        return renderSourceViewer(currentViewer);
      }
    });
    const unregisterEditor = context.ui.router.register({
      name: "sources-edit",
      render: () => {
        if (!currentEditor)
          throw new Error("Source editor has no active document");
        return renderSourceEditor(currentEditor);
      }
    });
    function edit(source, location, projectID) {
      const previousRoute = returnRoute ? { ...returnRoute } : { type: "home" };
      const draftKey = projectID + "/" + source.id;
      const recovered = drafts.entries[draftKey];
      const baseline = recovered?.source ?? source;
      if (recovered) {
        context.ui.toast.show({
          title: "SourcePier",
          message: "Recovered unsaved draft for " + safeLabel(source.id) + " (r" + baseline.revision + ")",
          variant: "info"
        });
      }
      let settled = false;
      let saveRequested = false;
      const current = {
        source: baseline,
        draft: recovered?.text,
        onDraft: (text) => {
          if (settled)
            return;
          const changed = draftToCanonical(baseline.content, text).changed;
          updateDrafts((state) => {
            if (changed || saveRequested || recovered)
              state.entries[draftKey] = { source: baseline, text };
            else
              delete state.entries[draftKey];
          });
        },
        save: async (content) => {
          saveRequested = true;
          const result = parseSavedSource(await rpc.saveSource({ id: baseline.id, expectedRevision: baseline.revision, expectedInstance: baseline.instanceId, content }, { location }), baseline.id);
          updateDrafts((state) => {
            const entry = state.entries[draftKey];
            if (entry && draftToCanonical(entry.source.content, entry.text).content === content) {
              delete state.entries[draftKey];
            }
          });
          return result;
        },
        back: () => {
          if (settled)
            return;
          settled = true;
          updateDrafts((state) => {
            delete state.entries[draftKey];
          });
          if (currentEditor === current)
            currentEditor = undefined;
          context.ui.router.navigate(previousRoute);
          setTimeout(() => void browse(location), 0);
        },
        gone: () => {
          if (settled)
            return;
          settled = true;
          if (currentEditor === current)
            currentEditor = undefined;
        }
      };
      currentEditor = current;
      context.ui.router.navigate({ type: "plugin", name: "sources-edit", data: { id: source.id } });
    }
    async function preview(source, location, projectID) {
      const previousRoute = { ...context.ui.router.current() };
      returnRoute = previousRoute;
      return new Promise((resolve) => {
        let settled = false;
        const current = {
          source,
          edit: () => edit(source, location, projectID),
          remove: () => deleteFlow(source, location, projectID, () => current.back()),
          exportMarkdown: () => exportFlow(source, location),
          back: () => {
            if (settled)
              return;
            settled = true;
            if (currentViewer === current)
              currentViewer = undefined;
            context.ui.router.navigate(previousRoute);
            setTimeout(() => resolve(true), 0);
          },
          gone: () => {
            if (settled)
              return;
            settled = true;
            if (currentViewer === current)
              currentViewer = undefined;
            resolve(false);
          }
        };
        currentViewer = current;
        context.ui.router.navigate({ type: "plugin", name: "sources-preview", data: { id: source.id } });
      });
    }
    async function browse(location) {
      while (true) {
        let projectID;
        let items;
        try {
          projectID = (await context.client.location.get({ location })).project.id;
          items = parseSourcesList(await rpc.listSources({}, { location }));
        } catch (error) {
          context.ui.toast.show({ title: "SourcePier", message: failureMessage(error), variant: "error" });
          return;
        }
        const options = [
          { title: "+ Add / Import Markdown", description: "Copy a file into this Project", value: "action:add" },
          { title: "\u21BB Refresh Sources", description: "Reload the latest Source index", value: "action:refresh" },
          ...items.sources.slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)).map((source) => ({
            title: source.id + " \xB7 " + source.format + " \xB7 r" + source.revision + " \xB7 " + (safeLabel(source.title) || source.id) + (drafts.entries[projectID + "/" + source.id] ? " \xB7 Unsaved draft" : ""),
            description: safeLabel(source.description ?? "", 160),
            value: source.id
          }))
        ];
        if (items.truncated) {
          options.push({
            title: "More Sources exist (showing first 100)",
            description: "Agent list uses the same bounded index",
            value: "action:limit"
          });
        }
        const selection = await context.ui.dialog.select({
          title: "SourcePier (" + items.sources.length + (items.truncated ? "+" : "") + ")",
          placeholder: "Search and select a Source to preview",
          options
        });
        if (selection === undefined)
          return;
        if (selection === "action:refresh" || selection === "action:limit")
          continue;
        if (selection === "action:add") {
          await importFlow(location);
          continue;
        }
        try {
          const source = parsePreview(await rpc.readSource({ id: selection }, { location }), selection);
          if (!await preview(source, location, projectID))
            return;
        } catch (error) {
          context.ui.toast.show({
            title: "SourcePier",
            message: failureMessage(error),
            variant: "error",
            duration: 6000
          });
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
            const location = context.location ?? context.data.location.default();
            const command = sourcesCommand(input);
            if (command.mode === "add")
              return importFlow(location, command.file);
            return browse(location);
          }
        },
        {
          id: "sourcepier.import",
          title: "Import Project Source",
          group: "SourcePier",
          palette: true,
          run: async () => {
            const location = context.location ?? context.data.location.default();
            await importFlow(location);
          }
        }
      ]
    }));
    return () => {
      currentViewer?.gone();
      currentEditor?.gone();
      const route = context.ui.router.current();
      if (returnRoute && route.type === "plugin" && (route.name === "sources-preview" || route.name === "sources-edit")) {
        context.ui.router.navigate(returnRoute);
      }
      unregisterEditor();
      unregisterViewer();
    };
  }
});
export {
  tui_default as default
};
