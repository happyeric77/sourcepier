import assert from "node:assert/strict"
import solidPlugin from "@opentui/solid/bun-plugin"

// Keep host-owned runtimes external so plugin hooks share the native TUI's context.
const result = await Bun.build({
  entrypoints: ["./src/tui.ts"],
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solidPlugin],
})
assert(result.success, result.logs.join("\n"))
assert.equal(result.outputs.length, 1)
const output = result.outputs[0]
if (process.argv.includes("--check")) {
  assert.equal(await Bun.file("./dist/tui.js").text(), await output.text(), "Run npm run build:tui before committing")
} else {
  await Bun.write("./dist/tui.js", await output.text())
}
