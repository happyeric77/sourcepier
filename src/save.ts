import type { Plugin } from "@opencode/plugin"
import { assertProjectID, assertSourceID, bodyKey, decodeMeta, MAX_BODY_BYTES, metaKey, readSource, sourceInstance, SourcesError } from "./sources.js"

type SaveStorage = Pick<Plugin.Context["storage"], "get" | "set">

export type SaveErrorCode =
  | "invalid_source_id"
  | "invalid_content"
  | "source_not_found"
  | "source_unavailable"
  | "project_unresolved"
  | "revision_conflict"
  | "revision_exhausted"
  | "publication_blocked"
  | "storage_unavailable"

export class SaveError extends Error {
  constructor(readonly code: SaveErrorCode, message: string) {
    super(message)
    this.name = "SaveError"
  }
}

function invalid(error: unknown): never {
  if (error instanceof SaveError) throw error
  if (error instanceof SourcesError) {
    if (error.code === "PROJECT_UNRESOLVED") throw new SaveError("project_unresolved", "An active Project is required")
    if (error.code === "INVALID_SOURCE_ID") throw new SaveError("invalid_source_id", "Choose a valid Source ID")
    if (error.code === "SOURCE_NOT_FOUND") throw new SaveError("source_not_found", "Source not found in this Project")
    if (error.code === "DATA_INTEGRITY_ERROR" || error.code === "UNSUPPORTED_SCHEMA") {
      throw new SaveError("source_unavailable", "This Source is unreadable")
    }
  }
  throw new SaveError("storage_unavailable", "SourcePier storage is unavailable")
}

function validateContent(content: string): void {
  if (typeof content !== "string" || !content.trim() || new TextEncoder().encode(content).length > MAX_BODY_BYTES) {
    throw new SaveError("invalid_content", "Markdown must be nonempty and at most 256 KiB")
  }
  // JSON serialization and TextEncoder silently replace unmatched UTF-16 surrogates.
  for (let index = 0; index < content.length; index++) {
    const ch = content.charCodeAt(index)
    if (ch >= 0xdc00 && ch <= 0xdfff) throw new SaveError("invalid_content", "Invalid Unicode in Markdown")
    if (ch >= 0xd800 && ch <= 0xdbff) {
      const next = content.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new SaveError("invalid_content", "Invalid Unicode in Markdown")
    }
  }
}

function sameBody(value: unknown, content: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "content" in value &&
    value.content === content
  )
}

/**
 * Publish one immutable revision. Caller MUST hold the shared writer lock
 * throughout expectedRevision validation, orphan check, body+meta publication.
 * This function is intentionally coordination-agnostic for deterministic tests.
 */
export async function saveSource(
  storage: SaveStorage,
  projectID: string,
  sourceID: string,
  expectedRevision: number,
  content: string,
  expectedInstance?: string,
): Promise<{ id: string; revision: number; changed: boolean }> {
  let key: string
  try {
    assertProjectID(projectID)
    key = metaKey(projectID, assertSourceID(sourceID))
  } catch (error) {
    return invalid(error)
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new SaveError("revision_conflict", "Reload the Source before saving")
  }
  validateContent(content)
  try {
    const raw = await storage.get(key)
    if (raw === undefined) throw new SaveError("source_not_found", "Source not found in this Project")
    const meta = decodeMeta(raw, projectID, sourceID)
    if (meta.instanceId !== undefined || expectedInstance !== undefined) {
      if (expectedInstance !== sourceInstance(meta)) {
        throw new SaveError("revision_conflict", "This Source was replaced; reopen before saving")
      }
    }
    if (meta.format !== "markdown") throw new SaveError("invalid_content", "Only Markdown Sources can be edited")
    if (meta.revision !== expectedRevision) {
      throw new SaveError("revision_conflict", "A newer revision exists; your draft was not discarded")
    }
    const current = await readSource(storage, projectID, sourceID)
    if (current.content === content) return { id: sourceID, revision: meta.revision, changed: false }
    if (meta.revision >= 999999) throw new SaveError("revision_exhausted", "Maximum revision reached")
    const nextRevision = meta.revision + 1
    const nextKey = bodyKey(projectID, sourceID, nextRevision)
    const priorBody = await storage.get(nextKey)
    if (priorBody !== undefined && !sameBody(priorBody, content)) {
      throw new SaveError("publication_blocked", "A pending revision exists; no Source was overwritten")
    }
    // Body first. An ambiguous body-set acknowledgment can be retried only
    // if the previous body is byte-for-byte identical.
    if (priorBody === undefined) await storage.set(nextKey, { schemaVersion: 1, content })
    const now = new Date().toISOString()
    try {
      await storage.set(key, { ...meta, revision: nextRevision, bodyKey: nextKey, updatedAt: now })
    } catch {
      // If the write committed before a connection error, verify publication.
      const latest = await readSource(storage, projectID, sourceID).catch(() => undefined)
      if (latest?.revision !== nextRevision || latest.content !== content) {
        throw new SaveError("storage_unavailable", "Save result is uncertain; reload before retrying")
      }
    }
    const published = await readSource(storage, projectID, sourceID)
    if (published.revision !== nextRevision || published.content !== content) {
      throw new SaveError("storage_unavailable", "Save could not be verified; reload before retrying")
    }
    return { id: sourceID, revision: nextRevision, changed: true }
  } catch (error) {
    return invalid(error)
  }
}
