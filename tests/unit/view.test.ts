import { describe, expect, test } from "bun:test"
import { parsePreview, parseSourcesList, safeLabel, sourcesCommand } from "../../src/view.js"
import plugin from "../../src/index.js"

describe("S3 browse commands", () => {
  test("bare /sources browses; add/import preserve S2 workflow", () => {
    expect(sourcesCommand()).toEqual({ mode: "browse" })
    expect(sourcesCommand("list")).toEqual({ mode: "browse" })
    expect(sourcesCommand("browse")).toEqual({ mode: "browse" })
    expect(sourcesCommand("add")).toEqual({ mode: "add" })
    expect(sourcesCommand("import")).toEqual({ mode: "add" })
    expect(sourcesCommand('add "~/Documents/My Example.md"')).toEqual({
      mode: "add",
      file: "~/Documents/My Example.md",
    })
    expect(sourcesCommand("notes/example.md")).toEqual({ mode: "add", file: "notes/example.md" })
  })

  test("full preview payload preserves every UTF-8 code point with no pagination", () => {
    const info = { id: "adr-full", title: "Full ADR", format: "markdown", revision: 1 }
    const body = "\uFEFF# Architecture\r\n" + "Chinese 中文, emoji 😊 and Markdown\n".repeat(1800)
    const result = parsePreview({ ...info, content: body, instanceId: "legacy:2026-10-15T00:00:00Z" }, "adr-full")
    expect(result.content).toBe(body)
    expect(new TextEncoder().encode(result.content)).toEqual(new TextEncoder().encode(body))
    expect(result.content.endsWith("Markdown\n")).toBe(true)
  })

  test("read-only RPC maps missing, integrity, storage and unresolved Project failures safely", async () => {
    type Handler = (input: unknown, call: unknown) => Promise<unknown>
    for (const projectID of ["project-a", "global"]) {
      let handlers: Record<string, Handler> | undefined
      const registration = { dispose: async () => {} }
      const cleanup: unknown = await Reflect.apply(plugin.setup, undefined, [{
        options: {},
        location: { directory: "/project-a", project: { id: projectID } },
        storage: {
          get: async (key: string) => {
            if (key.endsWith("/broken")) return { schemaVersion: 99 }
            if (key.endsWith("/unavailable")) throw Error("private storage path")
          },
          scan: async () => {
            throw Error("private storage path")
          },
        },
        rpc: {
          register: async (_: unknown, methods: Record<string, Handler>) => {
            handlers = methods
            return registration
          },
        },
        tool: { transform: async () => registration },
        session: { hook: async () => registration },
      }])
      if (!handlers || typeof cleanup !== "function") throw Error("Plugin did not register read methods")
      const call = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
      const unresolved = projectID === "global"
      expect(await handlers.listSources({}, call)).toMatchObject({
        type: unresolved ? "project_unresolved" : "storage_unavailable",
      })
      for (const [id, type] of [
        ["missing", "source_not_found"],
        ["../bad", "invalid_source_id"],
        ["broken", "source_unavailable"],
        ["unavailable", "storage_unavailable"],
      ]) {
        const result = await handlers.readSource({ id }, call)
        if (typeof result !== "object" || result === null || !("type" in result) || !("message" in result)) {
          throw Error("Missing RPC error response")
        }
        expect(result.type).toBe(unresolved ? "project_unresolved" : type)
        expect(result.message).not.toContain("private")
      }
      await cleanup()
    }
  })
})

describe("S3 RPC response guards", () => {
  const info = { id: "adr-001", title: "ADR-001", format: "markdown" as const, revision: 1 }
  test("valid list and exact read body", () => {
    expect(parseSourcesList({ sources: [info], truncated: false })).toEqual({
      sources: [info],
      truncated: false,
    })
    const content = "# 中文\n\n\x60\x60\x60ts\nlet x = 1\n\x60\x60\x60\n"
    expect(parsePreview({ ...info, content, instanceId: "legacy:2026-10-15T00:00:00Z" }, "adr-001").content).toBe(content)
    expect(safeLabel("Hello\nWorld\u001b[31m", 100)).not.toContain("\u001b")
  })

  test("rejects malformed index, corrupt read and mismatched Source ID", () => {
    expect(() => parseSourcesList({ sources: "bad", truncated: false })).toThrow()
    expect(() => parseSourcesList({ sources: [{ ...info, revision: "1" }], truncated: false })).toThrow()
    expect(() => parsePreview({ ...info, content: "ok" }, "project-b")).toThrow()
    expect(() => parsePreview({ ...info, content: null }, "adr-001")).toThrow()
    expect(() => parsePreview({ ...info, content: "ok" }, "adr-001")).toThrow()
  })
})
