import type { Plugin } from "@opencode/plugin"

/** Canonical Project-scoped Source reads shared by Agent tools and TUI RPC. */
type ReadStorage = Pick<Plugin.Context["storage"], "get" | "scan">

export const MAX_SOURCES = 100
export const MAX_BODY_BYTES = 256 * 1024
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const PROJECT_ID = /^[a-zA-Z0-9._:-]{1,180}$/

export type SourceFormat = "markdown" | "text"
export type SourceErrorCode =
  | "SESSION_NOT_FOUND"
  | "PROJECT_UNRESOLVED"
  | "SOURCE_NOT_FOUND"
  | "INVALID_SOURCE_ID"
  | "DATA_INTEGRITY_ERROR"
  | "UNSUPPORTED_SCHEMA"
  | "STORAGE_UNAVAILABLE"

export class SourcesError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = "SourcesError"
  }
}

export interface SourceMetaV1 {
  schemaVersion: 1
  id: string
  projectID: string
  title: string
  description?: string
  format: SourceFormat
  revision: number
  bodyKey: string
  createdAt: string
  updatedAt: string
  /** Import-incarnation identity; optional for pre-S5 persisted Sources. */
  instanceId?: string
}

export type ListedSource = Pick<SourceMetaV1, "id" | "title" | "description" | "format" | "revision">

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

export function assertProjectID(projectID: string): string {
  // OpenCode's special global project must never receive canonical sources.
  if (projectID === "global" || !PROJECT_ID.test(projectID)) {
    throw new SourcesError("PROJECT_UNRESOLVED")
  }
  return projectID
}

export function assertSourceID(id: string): string {
  if (!SOURCE_ID.test(id)) throw new SourcesError("INVALID_SOURCE_ID")
  return id
}

export function metaPrefix(projectID: string): string {
  return `projects/${assertProjectID(projectID)}/meta/`
}

export function metaKey(projectID: string, id: string): string {
  return `${metaPrefix(projectID)}${assertSourceID(id)}`
}

export function bodyKey(projectID: string, id: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999999) {
    throw new SourcesError("DATA_INTEGRITY_ERROR")
  }
  return `projects/${assertProjectID(projectID)}/body/${assertSourceID(id)}/r${String(revision).padStart(6, "0")}`
}

async function storageRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch {
    // In particular, never silently treat a failed storage call as "not found".
    throw new SourcesError("STORAGE_UNAVAILABLE")
  }
}

export function decodeMeta(value: unknown, projectID: string, id: string): SourceMetaV1 {
  if (!isRecord(value)) throw new SourcesError("DATA_INTEGRITY_ERROR")
  if (value.schemaVersion !== 1) throw new SourcesError("UNSUPPORTED_SCHEMA")
  if (
    value.id !== id ||
    value.projectID !== projectID ||
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    value.title.length > 200 ||
    (value.description !== undefined && typeof value.description !== "string") ||
    (value.format !== "markdown" && value.format !== "text") ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.bodyKey !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.instanceId !== undefined &&
      (typeof value.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(value.instanceId)))
  ) {
    throw new SourcesError("DATA_INTEGRITY_ERROR")
  }
  const revision = value.revision as number
  if (value.bodyKey !== bodyKey(projectID, id, revision)) {
    throw new SourcesError("DATA_INTEGRITY_ERROR")
  }
  return {
    schemaVersion: 1,
    id,
    projectID,
    title: value.title,
    ...(value.description === undefined ? {} : { description: value.description as string }),
    format: value.format,
    revision,
    bodyKey: value.bodyKey,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.instanceId === undefined ? {} : { instanceId: value.instanceId as string }),
  }
}

/** Legacy records derive a stable identity from createdAt, distinct from import UUIDs. */
export function sourceInstance(meta: SourceMetaV1): string {
  return meta.instanceId ?? "legacy:" + meta.createdAt
}

export async function listSources(
  storage: ReadStorage,
  projectID: string,
): Promise<{
  sources: ListedSource[]
  truncated: boolean
}> {
  const prefix = metaPrefix(projectID)
  // Scan metadata only; large document bodies live under separate keys.
  const entries: { key: string; value: unknown }[] = []
  let after: string | undefined
  do {
    const result = await storageRead(() => storage.scan({ prefix, after, limit: MAX_SOURCES + 1 - entries.length }))
    entries.push(...result.entries)
    after = result.next
  } while (after !== undefined && entries.length <= MAX_SOURCES)
  const sources = entries.slice(0, MAX_SOURCES).map((entry) => {
    const id = entry.key.slice(prefix.length)
    if (!SOURCE_ID.test(id)) throw new SourcesError("DATA_INTEGRITY_ERROR")
    const meta = decodeMeta(entry.value, projectID, id)
    return {
      id: meta.id,
      title: meta.title,
      ...(meta.description === undefined ? {} : { description: meta.description }),
      format: meta.format,
      revision: meta.revision,
    }
  })
  return { sources, truncated: entries.length > MAX_SOURCES || after !== undefined }
}

export function readSource(
  storage: Pick<Plugin.Context["storage"], "get">,
  projectID: string,
  sourceID: string,
  options: { includeInstance: true },
): Promise<ListedSource & { content: string; instanceId: string }>
export function readSource(
  storage: Pick<Plugin.Context["storage"], "get">,
  projectID: string,
  sourceID: string,
): Promise<ListedSource & { content: string }>
export async function readSource(
  storage: Pick<Plugin.Context["storage"], "get">,
  projectID: string,
  sourceID: string,
  options?: { includeInstance?: boolean },
): Promise<ListedSource & { content: string; instanceId?: string }> {
  assertProjectID(projectID)
  const id = assertSourceID(sourceID)
  const raw = await storageRead(() => storage.get(metaKey(projectID, id)))
  if (raw === undefined) throw new SourcesError("SOURCE_NOT_FOUND")
  const meta = decodeMeta(raw, projectID, id)
  const body = await storageRead(() => storage.get(meta.bodyKey))
  if (!isRecord(body)) throw new SourcesError("DATA_INTEGRITY_ERROR")
  if (body.schemaVersion !== 1) throw new SourcesError("UNSUPPORTED_SCHEMA")
  if (typeof body.content !== "string") throw new SourcesError("DATA_INTEGRITY_ERROR")
  if (new TextEncoder().encode(body.content).length > MAX_BODY_BYTES) {
    throw new SourcesError("DATA_INTEGRITY_ERROR", "Source body exceeds S1 size limit")
  }
  return {
    id: meta.id,
    title: meta.title,
    ...(meta.description === undefined ? {} : { description: meta.description }),
    format: meta.format,
    revision: meta.revision,
    content: body.content,
    ...(options?.includeInstance ? { instanceId: sourceInstance(meta) } : {}),
  }
}

export async function projectForSession(ctx: Plugin.Context, sessionID: string): Promise<string> {
  let session: Awaited<ReturnType<Plugin.Context["session"]["get"]>>
  try {
    session = await ctx.session.get({ sessionID })
  } catch {
    throw new SourcesError("SESSION_NOT_FOUND")
  }
  if (!session?.projectID) throw new SourcesError("PROJECT_UNRESOLVED")
  return assertProjectID(session.projectID)
}

export function errorPayload(error: unknown): {
  ok: false
  error: { code: SourceErrorCode; message: string }
} {
  if (error instanceof SourcesError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  // Never leak storage keys, internal paths, or incidental server errors into model context.
  return {
    ok: false,
    error: { code: "STORAGE_UNAVAILABLE", message: "SourcePier read failed" },
  }
}
