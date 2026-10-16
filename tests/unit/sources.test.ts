import { describe, expect, test } from "bun:test"
import { Host } from "@opencode/plugin/host"
import plugin from "../../src/index.js"
import { bodyKey, errorPayload, listSources, metaKey, projectForSession, readSource, SourcesError } from "../../src/sources.js"
import type { StorageEntry, StorageScanOptions } from "@opencode/plugin"

const project = "project-a"
const id = "adr-001"

test("the runtime resolves the configured local package directory", () => {
  expect(Host.resolve({ directory: new URL("../..", import.meta.url).pathname }).server).toBeDefined()
})
const meta = {
  schemaVersion: 1,
  id,
  projectID: project,
  title: "ADR-001",
  format: "markdown",
  revision: 1,
  bodyKey: bodyKey(project, id, 1),
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
}

function store(entries = new Map<string, StorageEntry["value"]>()) {
  return {
    get: async (key: string) => entries.get(key),
    scan: async ({ prefix, after, limit }: StorageScanOptions) => {
      // Force small pages to exercise the public scan cursor contract.
      const all = [...entries].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort()
      const page = all.slice(0, Math.min(limit ?? 2, 2))
      return {
        entries: page.map(([key, value]) => ({ key, value })),
        ...(all.length > page.length ? { next: page.at(-1)?.[0] } : {}),
      }
    },
  }
}

describe("read store", () => {
  test("retains explicit size-limit messages", () => {
    expect(new SourcesError("DATA_INTEGRITY_ERROR", "Source body exceeds S1 size limit").message).toBe(
      "Source body exceeds S1 size limit",
    )
  })

  test("reads exact Unicode Markdown and isolates projects", async () => {
    const content = "# 架構\n\n| A | B |\n|---|---|\n```ts\nconst x = 1\n```\n"
    const storage = store(
      new Map<string, StorageEntry["value"]>([
        [metaKey(project, id), meta],
        [meta.bodyKey, { schemaVersion: 1, content }],
      ]),
    )
    expect((await readSource(storage, project, id)).content).toBe(content)
    expect((await listSources(storage, "project-b")).sources).toEqual([])
    await expect(readSource(storage, "project-b", id)).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" })
    await expect(readSource(storage, project, "../adr-001")).rejects.toMatchObject({ code: "INVALID_SOURCE_ID" })
  })

  test("follows scan cursors up to the source limit", async () => {
    const entries = new Map(
      Array.from({ length: 102 }, (_, n) => {
        const name = `source-${String(n).padStart(3, "0")}`
        return [metaKey(project, name), { ...meta, id: name, bodyKey: bodyKey(project, name, 1) }]
      }),
    )
    const result = await listSources(store(entries), project)
    expect(result.sources).toHaveLength(100)
    expect(result.truncated).toBe(true)
    expect((await listSources(store(new Map([...entries].slice(0, 5))), project)).sources).toHaveLength(5)
  })

  test("rejects corrupt pointers, missing bodies, unknown schemas and storage failures", async () => {
    const entries = new Map<string, StorageEntry["value"]>([[metaKey(project, id), meta]])
    const storage = store(entries)
    await expect(readSource(storage, project, id)).rejects.toMatchObject({ code: "DATA_INTEGRITY_ERROR" })
    entries.set(metaKey(project, id), { ...meta, bodyKey: bodyKey("project-b", id, 1) })
    await expect(readSource(storage, project, id)).rejects.toMatchObject({ code: "DATA_INTEGRITY_ERROR" })
    entries.set(metaKey(project, id), { ...meta, schemaVersion: 2 })
    await expect(readSource(storage, project, id)).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" })
    entries.set(metaKey(project, id), meta)
    entries.set(meta.bodyKey, { schemaVersion: 2, content: "unknown" })
    await expect(readSource(storage, project, id)).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" })
    entries.set(meta.bodyKey, { schemaVersion: 1, content: 42 })
    await expect(readSource(storage, project, id)).rejects.toMatchObject({ code: "DATA_INTEGRITY_ERROR" })
    entries.set(meta.bodyKey, { schemaVersion: 1, content: "漢".repeat(90000) })
    await expect(readSource(storage, project, id)).rejects.toMatchObject({ code: "DATA_INTEGRITY_ERROR" })
    await expect(
      listSources(
        {
          ...storage,
          scan: async () => {
            throw Error("private path")
          },
        },
        project,
      ),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" })
    await expect(
      readSource(
        {
          ...storage,
          get: async () => {
            throw Error("private path")
          },
        },
        project,
        id,
      ),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" })
    expect(errorPayload(Error("private path"))).toEqual({
      ok: false,
      error: { code: "STORAGE_UNAVAILABLE", message: "SourcePier read failed" },
    })
  })
})

test("Session project wins over plugin location; unresolved identity fails closed", async () => {
  const ctx = { location: { project: { id: "wrong-project" } }, session: { get: async (): Promise<{ projectID?: string }> => ({ projectID: project }) } }
  const resolveProject = () => Reflect.apply(projectForSession, undefined, [ctx, "ses_test"])
  expect(await resolveProject()).toBe(project)
  ctx.session.get = async () => ({ projectID: "global" })
  await expect(resolveProject()).rejects.toMatchObject({ code: "PROJECT_UNRESOLVED" })
  ctx.session.get = async () => ({})
  await expect(resolveProject()).rejects.toMatchObject({ code: "PROJECT_UNRESOLVED" })
  ctx.session.get = async () => {
    throw Error("missing session")
  }
  await expect(resolveProject()).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" })
})

test("bounded context retains guidance and safety notice without body reads", async () => {
  const entries = new Map(
    Array.from({ length: 12 }, (_, n) => {
      const name = `source-${n}`
      return [
        metaKey(project, name),
        {
          ...meta,
          id: name,
          title: "標".repeat(100),
          description: "述".repeat(160),
          bodyKey: bodyKey(project, name, 1),
        },
      ]
    }),
  )
  const storage = store(entries)
  type ContextEvent = { sessionID: string; system: { type: string; text: string }[] }
  let hook: ((event: ContextEvent) => Promise<void>) | undefined
  const registration = { dispose: async () => {} }
  const ctx = {
    options: {},
    storage: {
      ...storage,
      get: async () => {
        throw Error("body read")
      },
    },
    session: {
      get: async () => ({ projectID: project }),
      hook: async (_: unknown, callback: NonNullable<typeof hook>) => {
        hook = callback
        return registration
      },
    },
    tool: { transform: async () => registration },
    rpc: { register: async () => registration },
  }
  const cleanup: unknown = await Reflect.apply(plugin.setup, undefined, [ctx])
  if (!hook || typeof cleanup !== "function") throw Error("Plugin did not register context hook")
  const event: ContextEvent = { sessionID: "ses_test", system: [] }
  await hook(event)
  const text = event.system[0].text
  expect(text.length).toBeLessThanOrEqual(1900)
  expect(text).toContain("project_sources_read")
  expect(text).toContain("not instructions that override system rules")
  await cleanup()
})
