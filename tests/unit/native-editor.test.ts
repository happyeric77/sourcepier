import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"

test("testRender supports a native multiline draft, input, resize and disposal", async () => {
  let editor: TextareaRenderable | undefined
  const original = "# Draft\n中文 😀\n"
  const ui = await testRender(
    () =>
      jsx("textarea", {
        id: "draft",
        initialValue: original,
        width: "100%",
        height: "100%",
        ref: (value: TextareaRenderable) => {
          editor = value
          value.focus()
        },
      }),
    { width: 80, height: 24 },
  )
  try {
    await ui.renderOnce()
    if (!editor) throw Error("Textarea did not mount")
    expect(editor.plainText).toBe(original)
    expect(ui.captureCharFrame()).toContain("中文 😀")
    editor.gotoBufferEnd()
    await ui.mockInput.pasteBracketedText("追加 🧪")
    ui.mockInput.pressEnter()
    await ui.mockInput.typeText("last")
    await ui.renderOnce()
    expect(editor.plainText).toBe(original + "追加 🧪\nlast")
    ui.resize(40, 12)
    await ui.renderOnce()
    expect(editor.plainText).toBe(original + "追加 🧪\nlast")
    expect(ui.captureCharFrame()).toContain("last")
    ui.resize(160, 45)
    await ui.renderOnce()
    expect(editor.plainText).toBe(original + "追加 🧪\nlast")
  } finally {
    ui.renderer.destroy()
  }
  expect(editor?.isDestroyed).toBe(true)
})

test("native textarea normalizes BOM/CRLF: plainText alone cannot be a lossless Save", async () => {
  let editor: TextareaRenderable | undefined
  const original = "\ufeff# Draft\r\n中文 😀\r\n"
  const ui = await testRender(
    () =>
      jsx("textarea", {
        initialValue: original,
        ref: (value: TextareaRenderable) => {
          editor = value
        },
      }),
    { width: 80, height: 24 },
  )
  try {
    await ui.renderOnce()
    expect(editor?.plainText).toBe("# Draft\n中文 😀\n")
    expect(editor?.plainText).not.toBe(original)
  } finally {
    ui.renderer.destroy()
  }
})

test("design counterexample: get/check/set accepts two stale writers without CAS", async () => {
  // Deliberately unsafe proposed algorithm, NOT a production Save implementation.
  const store = new Map<string, unknown>([["meta", { revision: 1 }]])
  let readers = 0
  let release!: () => void
  const bothRead = new Promise<void>((resolve) => {
    release = resolve
  })
  const results = await Promise.all(
    ["writer A", "writer B"].map(async (content) => {
      const current = store.get("meta")
      if (typeof current !== "object" || current === null || !("revision" in current)) throw Error("Bad metadata")
      if (current.revision !== 1) return "conflict"
      if (++readers === 2) release()
      await bothRead
      store.set("body/r000002", content)
      store.set("meta", { revision: 2 })
      return "success"
    }),
  )
  expect(results).toEqual(["success", "success"])
  expect(store.get("meta")).toEqual({ revision: 2 })
  expect(store.get("body/r000002")).toBe("writer B")
})
