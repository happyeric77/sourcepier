import { afterEach, expect, test } from "bun:test"
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { importMarkdown, loadMarkdown, resolveImportPath, sourceIDForFilename } from "../../src/import.js"
import { listSources, readSource } from "../../src/sources.js"
import plugin from "../../src/index.js"
import type { StorageEntry, StorageScanOptions } from "@opencode/plugin"

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(name: string, content: string | Uint8Array) {
  const dir = await mkdtemp(join(tmpdir(), "sources-s2-"))
  cleanup.push(dir)
  const file = join(dir, name)
  await writeFile(file, content)
  return { dir, file }
}

function storage() {
  const map = new Map<string, StorageEntry["value"]>()
  return {
    async get(key: string) {
      return map.get(key)
    },
    async set(key: string, value: StorageEntry["value"]) {
      map.set(key, value)
    },
    async scan({ prefix, after, limit }: StorageScanOptions) {
      const entries = [...map.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b))
      const page = entries.slice(0, limit ?? 100)
      return {
        entries: page.map(([key, value]) => ({ key, value })),
        ...(entries.length > page.length ? { next: page.at(-1)?.[0] } : {}),
      }
    },
  }
}

test("imports exact Markdown without modifying its source file; S1 read sees it", async () => {
  const content = "# 中文 ADR\n\n| a | b |\n| - | - |\n\n" + "Hello 😊\n"
  const { dir, file } = await fixture("ADR-002.md", content)
  const s = storage()
  const imported = await importMarkdown(s, "project-a", dir, "ADR-002.md")
  expect(imported).toEqual({ id: "adr-002", title: "ADR-002", revision: 1 })
  expect((await listSources(s, "project-a")).sources).toHaveLength(1)
  expect((await readSource(s, "project-a", "adr-002")).content).toBe(content)
  expect((await listSources(s, "project-b")).sources).toHaveLength(0)
  expect(await readFile(file, "utf8")).toBe(content)
  await expect(importMarkdown(s, "project-a", dir, file)).rejects.toMatchObject({ code: "already_exists" })
  expect((await readSource(s, "project-a", "adr-002")).content).toBe(content)
})

test("rejects invalid file type, empty content and invalid UTF-8 without publishing Source", async () => {
  const txt = await fixture("notes.txt", "text")
  const empty = await fixture("empty.md", " \n ")
  const bad = await fixture("bad.md", Buffer.from([0xc3, 0x28]))
  const big = await fixture("large.md", "x".repeat(256 * 1024 + 1))
  const s = storage()
  await expect(importMarkdown(s, "project-a", txt.dir, txt.file)).rejects.toMatchObject({ code: "invalid_path" })
  await expect(importMarkdown(s, "project-a", empty.dir, empty.file)).rejects.toMatchObject({
    code: "invalid_markdown",
  })
  await expect(importMarkdown(s, "project-a", bad.dir, bad.file)).rejects.toMatchObject({ code: "invalid_markdown" })
  await expect(importMarkdown(s, "project-a", big.dir, big.file)).rejects.toMatchObject({ code: "invalid_markdown" })
  expect((await listSources(s, "project-a")).sources).toHaveLength(0)
})

test("project scope, nested paths, non-Latin filenames and storage failures", async () => {
  const s = storage()
  const { dir } = await fixture("文件.md", "# 中文\n")
  expect(sourceIDForFilename("文件.md")).toMatch(/^source-[a-f0-9]{12}$/)
  expect(resolveImportPath("./文件.md", dir)).toBe(join(dir, "文件.md"))
  await expect(importMarkdown(s, "global", dir, "文件.md")).rejects.toMatchObject({ code: "project_unresolved" })
  const imported = await importMarkdown(s, "project-a", dir, "文件.md")
  expect(imported.id).toMatch(/^source-[a-f0-9]{12}$/)
  expect((await listSources(s, "project-a")).sources).toHaveLength(1)
  expect((await listSources(s, "project-b")).sources).toHaveLength(0)
  const failed = {
    ...s,
    set: async () => {
      throw Error("private file")
    },
  }
  const another = await fixture("fresh.md", "# fail\n")
  await expect(importMarkdown(failed, "project-a", another.dir, another.file)).rejects.toMatchObject({
    code: "storage_unavailable",
  })
})

test("preserves BOM and rejects unreadable metadata before any storage write", async () => {
  const bom = await fixture("bom.md", "\ufeff# Exact snapshot\n")
  const s = storage()
  await importMarkdown(s, "project-a", bom.dir, bom.file)
  expect((await readSource(s, "project-a", "bom")).content).toBe("\ufeff# Exact snapshot\n")
  const long = await fixture("a".repeat(201) + ".md", "# Long title\n")
  await expect(importMarkdown(s, "project-a", long.dir, long.file)).rejects.toMatchObject({ code: "invalid_path" })
  expect((await listSources(s, "project-a")).sources).toHaveLength(1)
})

test("rejects named pipes without waiting for a writer", async () => {
  const { dir } = await fixture("regular.md", "# File\n")
  const fifo = join(dir, "pipe.md")
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0)
  await expect(loadMarkdown(fifo)).rejects.toMatchObject({ code: "invalid_path" })
}, 1000)

test("RPC uses native Location, never a caller project override", async () => {
  let handler: ((input: unknown, call: unknown) => Promise<unknown>) | undefined
  const registration = { dispose: async () => {} }
  const s = storage()
  const { dir, file } = await fixture("scoped.md", "# Scoped\n")
  const previousLockRoot = process.env.OPENCODE_SOURCES_LOCK_ROOT
  process.env.OPENCODE_SOURCES_LOCK_ROOT = join(dir, ".isolated-writer-locks")
  try {
  // Deliberately partial host double: runtime invocation does not assert a full Plugin.Context.
  const cleanup: unknown = await Reflect.apply(plugin.setup, undefined, [{
    options: {},
    storage: s,
    location: { directory: dir, project: { id: "project-a" } },
    rpc: {
      register: async (_: unknown, handlers: { importMarkdown: NonNullable<typeof handler> }) => {
        handler = handlers.importMarkdown
        return registration
      },
    },
    tool: { transform: async () => registration },
    session: { hook: async () => registration },
  }])
  if (!handler || typeof cleanup !== "function") throw Error("Plugin did not register import")
  const call = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  expect(await handler({ file, projectID: "project-b" }, call)).toMatchObject({ id: "scoped", revision: 1 })
  expect(await handler({ file }, call)).toMatchObject({ type: "already_exists" })
  expect((await readSource(s, "project-a", "scoped")).content).toBe("# Scoped\n")
  expect((await listSources(s, "project-b")).sources).toHaveLength(0)
  await cleanup()
  } finally {
    if (previousLockRoot === undefined) delete process.env.OPENCODE_SOURCES_LOCK_ROOT
    else process.env.OPENCODE_SOURCES_LOCK_ROOT = previousLockRoot
  }
})

test("failed metadata publish leaves an immutable orphan, never a visible partial Source", async () => {
  const { dir, file } = await fixture("interrupted.md", "# Original\n")
  const s = storage()
  const failing = {
    ...s,
    set: async (key: string, value: StorageEntry["value"]) => {
      if (key.includes("/meta/")) throw Error("private storage detail")
      await s.set(key, value)
    },
  }
  await expect(importMarkdown(failing, "project-a", dir, file)).rejects.toMatchObject({
    code: "storage_unavailable",
    message: "SourcePier storage is unavailable",
  })
  expect((await listSources(s, "project-a")).sources).toHaveLength(0)
  await writeFile(file, "# Changed\n")
  await expect(importMarkdown(s, "project-a", dir, file)).rejects.toMatchObject({ code: "already_exists" })
  expect(await s.get("projects/project-a/body/interrupted/r000001")).toEqual({
    schemaVersion: 1,
    content: "# Original\n",
  })
})

test("overlapping imports in one process reject without overwriting", async () => {
  const { dir, file } = await fixture("concurrent.md", "# Snapshot\n")
  const s = storage()
  let release = () => {}
  let entered = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const delayed = {
    ...s,
    set: async (key: string, value: StorageEntry["value"]) => {
      if (key.includes("/body/")) {
        entered()
        await blocked
      }
      await s.set(key, value)
    },
  }
  const first = importMarkdown(delayed, "project-a", dir, file)
  await ready
  try {
    await expect(importMarkdown(s, "project-a", dir, file)).rejects.toMatchObject({ code: "already_exists" })
  } finally {
    release()
  }
  await first
  expect((await readSource(s, "project-a", "concurrent")).content).toBe("# Snapshot\n")
})
