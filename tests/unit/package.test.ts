import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Check the package users actually receive, not only package.json declarations.
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  private?: boolean
  main?: string
  exports: Record<string, string>
  files: string[]
  scripts: Record<string, string>
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
}

test("packed OpenCode plugin contains Server, RPC, and TUI entrypoints without tests", () => {
  expect(manifest.exports["./tui"]).toBe("./dist/tui.js")
  expect(manifest.private).not.toBe(true)
  expect(manifest.dependencies["@opencode/plugin"]).toBe("2.0.26")
  for (const peer of ["@opentui/core", "@opentui/solid", "solid-js"]) {
    expect(manifest.peerDependencies[peer]).toBeDefined()
  }

  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  })
  const tarballs = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>
  expect(tarballs).toHaveLength(1)
  const packed = new Set(tarballs[0].files.map((file) => file.path))
  for (const entry of [manifest.main, ...Object.values(manifest.exports)]) {
    if (!entry) continue
    expect(packed.has(entry.replace(/^\.\//, ""))).toBe(true)
  }
  for (const filename of readdirSync(resolve(root, "src"))) {
    if (/\.(?:ts|tsx)$/.test(filename)) expect(packed.has("src/" + filename)).toBe(true)
  }
  expect(packed.has("tsconfig.json")).toBe(true)
  for (const filename of packed) {
    expect(filename.startsWith("tests/")).toBe(false)
    expect(filename.startsWith("scripts/")).toBe(false)
    expect(filename.startsWith("docs/")).toBe(false)
    expect(filename === "package-lock.json").toBe(false)
  }
})

test("distributed TUI is current compiled OpenTUI code, not host-transformed TSX", () => {
  expect(manifest.scripts.build).toBeUndefined()
  expect(manifest.scripts["build:tui"]).toBe("bun scripts/build-tui.ts")
  execFileSync(process.execPath, ["scripts/build-tui.ts", "--check"], { cwd: root, stdio: "pipe" })
  const tui = readFileSync(resolve(root, manifest.exports["./tui"]), "utf8")
  expect(readFileSync(resolve(root, "tui.ts"), "utf8")).toContain('from "./dist/tui.js"')
  expect(tui).toContain('from "@opentui/solid"')
  expect(tui).not.toContain('from "react"')
  expect(tui).not.toContain("jsx-runtime")
  expect(tui).toMatch(/SyntaxStyle\.fromStyles\([\s\S]*?},\s*context\.renderer\.nativeScene\)/)
  expect(tui).toContain("context.renderer.idle().then(() => syntaxStyle.destroy())")
})


test("SourcePier package uses consistent Server, RPC, and TUI identities", () => {
  expect((manifest as typeof manifest & { name: string }).name).toBe("sourcepier")
  const server = readFileSync(resolve(root, "src/index.ts"), "utf8")
  const rpc = readFileSync(resolve(root, "src/rpc.ts"), "utf8")
  const tui = readFileSync(resolve(root, "src/tui.ts"), "utf8")
  expect(server).toMatch(/id:\s*"sourcepier"/)
  expect(rpc).toMatch(/id:\s*"sourcepier"/)
  expect(tui).toMatch(/id:\s*"sourcepier\.tui"/)
  const bundled = readFileSync(resolve(root, "dist/tui.js"), "utf8")
  expect(bundled).toContain('id: "sourcepier.tui"')
  expect(bundled).toContain('id: "sourcepier"')
})
