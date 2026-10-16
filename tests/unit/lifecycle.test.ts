import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, open, readFile, rm, symlink, writeFile, type FileHandle } from "node:fs/promises"
import type { StorageEntry, StorageScanOptions } from "@opencode/plugin"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deleteSource } from "../../src/delete.js"
import { exportSource } from "../../src/export.js"
import { importMarkdown } from "../../src/import.js"
import { saveSource } from "../../src/save.js"
import { SourcesRPC } from "../../src/rpc.js"
import { bodyKey, listSources, metaKey, readSource } from "../../src/sources.js"

const project = "project-a"
const id = "draft"
const original = "\ufeff# 標題\r\n中文 😀\r\n"
const owned: string[] = []

afterEach(async () => {
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "sourcepier-s5-"))
  owned.push(path)
  return path
}

function fixture(revision = 1) {
  const values = new Map<string, StorageEntry["value"]>()
  values.set(metaKey(project, id), {
    schemaVersion: 1,
    projectID: project,
    id,
    title: "draft",
    format: "markdown",
    revision,
    bodyKey: bodyKey(project, id, revision),
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
  })
  for (let n = 1; n <= revision; n++) {
    values.set(bodyKey(project, id, n), { schemaVersion: 1, content: n === revision ? original : "# older\n" })
  }
  const store = {
    async get(key: string) {
      return values.get(key)
    },
    async set(key: string, value: StorageEntry["value"]) {
      values.set(key, value)
    },
    async remove(key: string) {
      values.delete(key)
    },
    async scan({ prefix, after, limit }: StorageScanOptions) {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit ?? 100)
        .map(([key, value]) => ({ key, value }))
      return { entries, next: entries.length === (limit ?? 100) ? entries.at(-1)?.key : undefined }
    },
  }
  return { values, store }
}

test("S5 Delete removes current metadata and all immutable historical revisions", async () => {
  const { values, store } = fixture(35)
  const result = await deleteSource(store, project, id, 35)
  expect(result).toEqual({ id, deleted: true, revisionsRemoved: 35 })
  expect(values.has(metaKey(project, id))).toBe(false)
  for (let rev = 1; rev <= 35; rev++) expect(values.has(bodyKey(project, id, rev))).toBe(false)
  expect((await listSources(store, project)).sources).toEqual([])
  await expect(readSource(store, project, id)).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" })
})

test("S5 stale Delete refuses to remove the newer Source revision", async () => {
  const { values, store } = fixture(2)
  await expect(deleteSource(store, project, id, 1)).rejects.toMatchObject({ code: "revision_conflict" })
  expect(values.has(metaKey(project, id))).toBe(true)
  expect((await readSource(store, project, id)).revision).toBe(2)
})

test("S5 paginated cleanup keeps r1 until later pages are purged", async () => {
  const { values, store } = fixture(3)
  const paged = {
    ...store,
    scan: async ({ prefix, after }: StorageScanOptions) => {
      const page = await store.scan({ prefix, after, limit: 1 })
      return { ...page, next: page.entries[0]?.key }
    },
    remove: async (key: string) => {
      if (key === bodyKey(project, id, 2)) throw Error("interrupted cleanup")
      await store.remove(key)
    },
  }
  await expect(deleteSource(paged, project, id, 3)).rejects.toMatchObject({ code: "cleanup_incomplete" })
  expect(values.has(bodyKey(project, id, 1))).toBe(true)
  expect(values.has(bodyKey(project, id, 3))).toBe(true)
  await deleteSource({ ...paged, remove: store.remove }, project, id, 3)
  expect([...values.keys()]).toEqual([])
})

test("S5 Delete is Project-scoped and validates missing/malformed IDs", async () => {
  const { values, store } = fixture()
  await expect(deleteSource(store, "global", id, 1)).rejects.toMatchObject({ code: "project_unresolved" })
  await expect(deleteSource(store, project, "../draft", 1)).rejects.toMatchObject({ code: "invalid_source_id" })
  await expect(deleteSource(store, "project-b", id, 1)).rejects.toMatchObject({ code: "source_not_found" })
  await expect(deleteSource(store, project, "missing", 1)).rejects.toMatchObject({ code: "source_not_found" })
  expect(values.has(metaKey(project, id))).toBe(true)
})

test("S5 Delete failure before metadata removal preserves the readable Source", async () => {
  const { values, store } = fixture(2)
  const fault = {
    ...store,
    remove: async (key: string) => {
      if (key === metaKey(project, id)) throw Error("private backend error")
      await store.remove(key)
    },
  }
  await expect(deleteSource(fault, project, id, 2)).rejects.toMatchObject({ code: "storage_unavailable" })
  expect((await readSource(store, project, id)).content).toBe(original)
  expect(values.has(bodyKey(project, id, 1))).toBe(true)
})

test("S5 interrupted revision cleanup reports partial result and retries without a tombstone", async () => {
  const { values, store } = fixture(3)
  let failed = false
  const fault = {
    ...store,
    remove: async (key: string) => {
      if (key === bodyKey(project, id, 2) && !failed) {
        failed = true
        throw Error("private storage detail")
      }
      await store.remove(key)
    },
  }
  await expect(deleteSource(fault, project, id, 3)).rejects.toMatchObject({
    code: "cleanup_incomplete",
    message: expect.not.stringContaining("private"),
  })
  expect(values.has(metaKey(project, id))).toBe(false)
  expect(values.has(bodyKey(project, id, 1))).toBe(true)
  const dir = await directory()
  await writeFile(join(dir, "draft.md"), original)
  await expect(importMarkdown(store, project, dir, "draft.md")).rejects.toMatchObject({ code: "already_exists" })
  const retried = await deleteSource(store, project, id, 3)
  expect(retried.deleted).toBe(true)
  expect([...values.keys()].filter((key) => key.includes("/body/draft/"))).toEqual([])
  const reimported = await importMarkdown(store, project, dir, "draft.md")
  expect(reimported).toMatchObject({ id, revision: 1 })
  expect((await readSource(store, project, id)).content).toBe(original)
})

test("S5 Export preserves exact BOM/CRLF and does not mutate canonical Source", async () => {
  const { store } = fixture(2)
  const dir = await directory()
  const output = join(dir, "export.md")
  const result = await exportSource(store, project, id, dir, output)
  expect(result).toEqual({ id, revision: 2, path: output, bytes: Buffer.byteLength(original) })
  expect(await readFile(output, "utf8")).toBe(original)
  expect((await readSource(store, project, id)).revision).toBe(2)
  await expect(exportSource(store, project, id, dir, output)).rejects.toMatchObject({ code: "already_exists" })
  expect(await readFile(output, "utf8")).toBe(original)
})

test("S5 Export rejects existing files, symlinks, invalid paths and missing parent folders", async () => {
  const { store } = fixture()
  const dir = await directory()
  const existing = join(dir, "original.md")
  await writeFile(existing, "DO NOT TOUCH")
  const link = join(dir, "alias.md")
  await symlink(existing, link)
  for (const path of [existing, link]) {
    await expect(exportSource(store, project, id, dir, path)).rejects.toMatchObject({ code: "already_exists" })
  }
  expect(await readFile(existing, "utf8")).toBe("DO NOT TOUCH")
  for (const path of ["", "notes.txt", "bad\0.md", join(dir, "missing", "new.md")]) {
    await expect(exportSource(store, project, id, dir, path)).rejects.toMatchObject({ code: "invalid_path" })
  }
})

test("S5 Export is Project-scoped and does not create files for absent Sources", async () => {
  const { store } = fixture()
  const dir = await directory()
  const missing = join(dir, "nothing.md")
  await expect(exportSource(store, "project-b", id, dir, missing)).rejects.toMatchObject({ code: "source_not_found" })
  await expect(exportSource(store, project, "../bad", dir, missing)).rejects.toMatchObject({
    code: "invalid_source_id",
  })
  await expect(readFile(missing, "utf8")).rejects.toThrow()
})

test("S5 Export removes only its own partial output on write or sync failure", async () => {
  const { store } = fixture(2)
  const dir = await directory()
  const existing = join(dir, "keep.md")
  await writeFile(existing, "DO NOT TOUCH")
  const probe = await open(join(dir, "probe"), "w")
  const prototype = Object.getPrototypeOf(probe)
  await probe.close()
  for (const method of ["writeFile", "sync"]) {
    const output = join(dir, method + ".md")
    const fault = spyOn(prototype, method).mockImplementation(async function (this: FileHandle) {
      if (method === "writeFile") await this.write("partial output")
      throw Error("private disk failure")
    })
    try {
      await expect(exportSource(store, project, id, dir, output)).rejects.toMatchObject({
        code: "write_failed",
        message: expect.not.stringContaining("private"),
      })
    } finally {
      fault.mockRestore()
    }
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(existing, "utf8")).toBe("DO NOT TOUCH")
    expect((await readSource(store, project, id)).content).toBe(original)
  }
})

test("S5 ABA: old r1 Save and Delete cannot modify a same-ID reimported Source", async () => {
  const { store } = fixture()
  const dir = await directory()
  const file = join(dir, "aba.md")
  await writeFile(file, "# First incarnation\n")
  await importMarkdown(store, project, dir, file)
  const original = await readSource(store, project, "aba", { includeInstance: true })
  expect(original.instanceId).toMatch(/^[a-f0-9-]{36}$/)
  expect(await readSource(store, project, "aba")).not.toHaveProperty("instanceId")

  await deleteSource(store, project, "aba", 1, original.instanceId)
  await writeFile(file, "# Second incarnation\n")
  await importMarkdown(store, project, dir, file)
  const current = await readSource(store, project, "aba", { includeInstance: true })
  expect(current.instanceId).not.toBe(original.instanceId)
  expect(current.revision).toBe(1)

  await expect(saveSource(store, project, "aba", 1, "# Stale Save\n", original.instanceId)).rejects.toMatchObject({
    code: "revision_conflict",
  })
  await expect(deleteSource(store, project, "aba", 1, original.instanceId)).rejects.toMatchObject({
    code: "revision_conflict",
  })
  await expect(saveSource(store, project, "aba", 1, "# Missing token\n")).rejects.toMatchObject({
    code: "revision_conflict",
  })
  await expect(deleteSource(store, project, "aba", 1)).rejects.toMatchObject({
    code: "revision_conflict",
  })
  expect(await readSource(store, project, "aba", { includeInstance: true })).toEqual(current)

  expect((await saveSource(store, project, "aba", 1, "# New owner Save\n", current.instanceId)).revision).toBe(2)
  await expect(deleteSource(store, project, "aba", 1, current.instanceId)).rejects.toMatchObject({
    code: "revision_conflict",
  })
  expect((await deleteSource(store, project, "aba", 2, current.instanceId)).deleted).toBe(true)
})
test("write RPC schemas declare every required input including incarnation", () => {
  for (const name of ["saveSource", "deleteSource"] as const) {
    const schema = SourcesRPC.methods[name].input
    expect(schema.required).toContain("expectedInstance")
    for (const key of schema.required) expect(key in schema.properties).toBe(true)
    expect(schema.properties.expectedInstance).toEqual({ type: "string", minLength: 1 })
  }
})
