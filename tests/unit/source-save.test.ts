import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { draftToCanonical, editorInitialValue } from "../../src/edit-draft.js"
import { saveSource } from "../../src/save.js"
import { bodyKey, metaKey, readSource } from "../../src/sources.js"
import { withWriterLock, WriterError, writerLockPath } from "../../src/writer.js"
import { parseSavedSource } from "../../src/view.js"
import type { StorageEntry } from "@opencode/plugin"

test("Save receipt must match the requested Source and contain a valid revision", () => {
  expect(parseSavedSource({ id: "adr", revision: 2, changed: true }, "adr")).toEqual({
    id: "adr",
    revision: 2,
    changed: true,
  })
  for (const value of [
    null,
    {},
    { id: "other", revision: 2, changed: true },
    { id: "adr", revision: 0, changed: false },
  ]) {
    expect(() => parseSavedSource(value, "adr")).toThrow()
  }
})

const project = "project-a"
const id = "adr"
function fixture(content = "# Original\r\n") {
  const map = new Map<string, StorageEntry["value"]>()
  const original = {
    schemaVersion: 1 as const,
    id,
    projectID: project,
    title: "ADR",
    format: "markdown" as const,
    revision: 1,
    bodyKey: bodyKey(project, id, 1),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
  map.set(metaKey(project, id), original)
  map.set(bodyKey(project, id, 1), { schemaVersion: 1, content })
  return {
    map,
    storage: {
      get: async (key: string) => map.get(key),
      set: async (key: string, value: StorageEntry["value"]) => {
        map.set(key, value)
      },
    },
  }
}

test("S4 Save publishes immutable revision and Agent read sees latest, with Project isolation", async () => {
  const { map, storage } = fixture("# Original\n")
  const result = await saveSource(storage, project, id, 1, "# 新的文件 😊\n")
  expect(result).toEqual({ id, revision: 2, changed: true })
  expect(await readSource(storage, project, id)).toMatchObject({ revision: 2, content: "# 新的文件 😊\n" })
  expect(map.get(bodyKey(project, id, 1))).toEqual({ schemaVersion: 1, content: "# Original\n" })
  expect(map.get(bodyKey(project, id, 2))).toEqual({ schemaVersion: 1, content: "# 新的文件 😊\n" })
  await expect(saveSource(storage, "project-b", id, 1, "bad")).rejects.toMatchObject({ code: "source_not_found" })
  await expect(readSource(storage, "project-b", id)).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" })
})

test("S4 Save rejects stale revisions without touching content or overwriting the immutable body", async () => {
  const { map, storage } = fixture()
  await saveSource(storage, project, id, 1, "# Writer A\n")
  await expect(saveSource(storage, project, id, 1, "# Writer B\n")).rejects.toMatchObject({ code: "revision_conflict" })
  expect((await readSource(storage, project, id)).content).toBe("# Writer A\n")
  expect(map.get(bodyKey(project, id, 2))).toEqual({ schemaVersion: 1, content: "# Writer A\n" })
})

test("S4 unchanged save is a no-op and native textarea formatting is lossless when untouched", async () => {
  const original = "\uFEFF# Heading\r\n中文 😊\r\n"
  const { storage, map } = fixture(original)
  expect(editorInitialValue(original)).toBe("# Heading\n中文 😊\n")
  expect(draftToCanonical(original, editorInitialValue(original))).toEqual({ content: original, changed: false })
  expect(draftToCanonical(original, "# Changed\n中文 😊\n")).toEqual({
    content: "\uFEFF# Changed\r\n中文 😊\r\n",
    changed: true,
  })
  expect(draftToCanonical("# mixed\r\nline\n", "# mixed\nchanged\n").content).toBe("# mixed\nchanged\n")
  expect(await saveSource(storage, project, id, 1, original)).toEqual({ id, revision: 1, changed: false })
  expect(map.has(bodyKey(project, id, 2))).toBe(false)
})

test("S4 Save validates UTF-8, length, Markdown, project and source ID", async () => {
  const { storage } = fixture()
  for (const content of ["", " \n ", "x".repeat(262145), "\ud800 lone"]) {
    await expect(saveSource(storage, project, id, 1, content)).rejects.toMatchObject({ code: "invalid_content" })
  }
  await expect(saveSource(storage, "global", id, 1, "valid")).rejects.toMatchObject({ code: "project_unresolved" })
  await expect(saveSource(storage, project, "../bad", 1, "valid")).rejects.toMatchObject({ code: "invalid_source_id" })
  await expect(saveSource(storage, project, id, -1, "valid")).rejects.toMatchObject({ code: "revision_conflict" })
})

test("S4 orphan body cannot be overwritten; an identical retry may publish it", async () => {
  const { map, storage } = fixture()
  map.set(bodyKey(project, id, 2), { schemaVersion: 1, content: "# Prepared\n" })
  await expect(saveSource(storage, project, id, 1, "# Different\n")).rejects.toMatchObject({
    code: "publication_blocked",
  })
  expect(map.get(bodyKey(project, id, 2))).toEqual({ schemaVersion: 1, content: "# Prepared\n" })
  expect(await saveSource(storage, project, id, 1, "# Prepared\n")).toMatchObject({ revision: 2, changed: true })
})

test("S4 ambiguous metadata acknowledgment verifies the live revision before reporting success", async () => {
  const { map, storage } = fixture()
  let throwAfterCommit = true
  const unreliable = {
    get: storage.get,
    set: async (key: string, value: StorageEntry["value"]) => {
      await storage.set(key, value)
      if (key === metaKey(project, id) && throwAfterCommit) {
        throwAfterCommit = false
        throw Error("private database path")
      }
    },
  }
  expect(await saveSource(unreliable, project, id, 1, "# New\n")).toMatchObject({ revision: 2 })
  expect((await readSource(storage, project, id)).content).toBe("# New\n")
  expect(map.get(bodyKey(project, id, 1))).toEqual({ schemaVersion: 1, content: "# Original\r\n" })
})

test("S4 metadata fault leaves published revision unchanged; conflicting orphan blocks different retry", async () => {
  const { map, storage } = fixture()
  const failed = {
    get: storage.get,
    set: async (key: string, value: StorageEntry["value"]) => {
      if (key === metaKey(project, id)) throw Error("private storage failure")
      await storage.set(key, value)
    },
  }
  await expect(saveSource(failed, project, id, 1, "# Partial\n")).rejects.toMatchObject({
    code: "storage_unavailable",
    message: expect.not.stringContaining("private"),
  })
  expect((await readSource(storage, project, id)).revision).toBe(1)
  expect(map.has(bodyKey(project, id, 2))).toBe(true)
  await expect(saveSource(storage, project, id, 1, "# Other\n")).rejects.toMatchObject({ code: "publication_blocked" })
  expect((await saveSource(storage, project, id, 1, "# Partial\n")).revision).toBe(2)
})

const owned: string[] = []
afterEach(async () => {
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test("S4 filesystem writer lock fails closed under contention and releases on exception", async () => {
  const root = await mkdtemp(join(tmpdir(), "sourcepier-writer-test-"))
  owned.push(root)
  const lock = join(root, "state", "source.lock")
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let acquired!: () => void
  const locked = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const first = withWriterLock(async () => {
    acquired()
    await wait
  }, lock)
  await locked
  await expect(withWriterLock(async () => "unsafe", lock)).rejects.toBeInstanceOf(WriterError)
  release()
  await first
  expect(await withWriterLock(async () => "safe", lock)).toBe("safe")
  await expect(
    withWriterLock(async () => {
      throw Error("controlled")
    }, lock),
  ).rejects.toThrow("controlled")
  expect(await withWriterLock(async () => "safe again", lock)).toBe("safe again")
})

test("S4 lock root is outside repository by default and custom lock root requires absolute path", () => {
  const home = "/tmp/standalone-home"
  const path = writerLockPath(
    {
      XDG_DATA_HOME: "/tmp/shared-data",
      XDG_STATE_HOME: "/tmp/shared-state",
      OPENCODE_DB: "/tmp/shared-data/opencode/open.db",
    },
    home,
  )
  expect(path.startsWith("/tmp/shared-state/opencode/sources-locks/")).toBe(true)
  expect(() => writerLockPath({ OPENCODE_SOURCES_LOCK_ROOT: "relative" }, home)).toThrow()
})
