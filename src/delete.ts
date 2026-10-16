import type { Plugin } from "@opencode/plugin"
import { assertProjectID, assertSourceID, decodeMeta, metaKey, sourceInstance, SourcesError } from "./sources.js"

type DeleteStorage = Pick<Plugin.Context["storage"], "get" | "remove" | "scan">

export type DeleteErrorCode =
  | "invalid_source_id"
  | "project_unresolved"
  | "source_not_found"
  | "source_unavailable"
  | "revision_conflict"
  | "cleanup_incomplete"
  | "storage_unavailable"

export class DeleteError extends Error {
  constructor(
    readonly code: DeleteErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "DeleteError"
  }
}

function sourceError(error: unknown): never {
  if (error instanceof DeleteError) throw error
  if (error instanceof SourcesError) {
    if (error.code === "PROJECT_UNRESOLVED")
      throw new DeleteError("project_unresolved", "An active Project is required")
    if (error.code === "INVALID_SOURCE_ID") throw new DeleteError("invalid_source_id", "Invalid Source ID")
    if (error.code === "SOURCE_NOT_FOUND") throw new DeleteError("source_not_found", "Source not found")
    if (error.code === "DATA_INTEGRITY_ERROR" || error.code === "UNSUPPORTED_SCHEMA") {
      throw new DeleteError("source_unavailable", "Source metadata is unreadable")
    }
  }
  throw new DeleteError("storage_unavailable", "SourcePier storage is unavailable")
}

function bodyPrefix(projectID: string, id: string): string {
  return `projects/${assertProjectID(projectID)}/body/${assertSourceID(id)}/`
}

/**
 * Delete the index and every immutable revision body. This is deliberately
 * NOT a transaction; if body cleanup fails, the RPC reports an incomplete
 * deletion and calling it again with the same ID completes cleanup.
 *
 * The r000001 key is removed last, preventing reimport while other revisions
 * still require cleanup.
 *
 * Caller holds the shared writer lock used by Import and Save.
 */
export async function deleteSource(
  storage: DeleteStorage,
  projectID: string,
  id: string,
  expectedRevision: number,
  expectedInstance?: string,
): Promise<{ id: string; deleted: true; revisionsRemoved: number }> {
  let key: string
  let prefix: string
  try {
    key = metaKey(projectID, id)
    prefix = bodyPrefix(projectID, id)
  } catch (error) {
    return sourceError(error)
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision > 999999) {
    throw new DeleteError("revision_conflict", "Reload the Source before deleting")
  }
  let removedIndex = false
  try {
    const raw = await storage.get(key)
    if (raw !== undefined) {
      const meta = decodeMeta(raw, projectID, id)
      if (meta.instanceId !== undefined || expectedInstance !== undefined) {
        if (expectedInstance !== sourceInstance(meta)) {
          throw new DeleteError("revision_conflict", "This Source was replaced; reopen before deleting")
        }
      }
      if (meta.revision !== expectedRevision)
        throw new DeleteError("revision_conflict", "Source changed; reload before deleting")
      await storage.remove(key)
      if ((await storage.get(key)) !== undefined) {
        throw new DeleteError("storage_unavailable", "Could not remove Source index")
      }
      removedIndex = true
    }
  } catch (error) {
    return sourceError(error)
  }

  const firstKey = prefix + "r000001"
  let removed = 0
  try {
    let after: string | undefined
    do {
      // Small batches avoid reading every 256 KiB body into memory at once.
      const page = await storage.scan({ prefix, after, limit: 16 })
      for (const entry of page.entries) {
        if (!/^r\d{6}$/.test(entry.key.slice(prefix.length))) {
          throw new DeleteError("cleanup_incomplete", "Unexpected Source revision key; cleanup incomplete")
        }
        if (entry.key === firstKey) continue
        await storage.remove(entry.key)
        if ((await storage.get(entry.key)) !== undefined) {
          throw new DeleteError("cleanup_incomplete", "Source revision could not be removed")
        }
        removed++
      }
      after = page.next
    } while (after !== undefined)
    if ((await storage.get(firstKey)) !== undefined) {
      await storage.remove(firstKey)
      removed++
    }
    if (!removedIndex && removed === 0) {
      throw new DeleteError("source_not_found", "Source not found")
    }
    if ((await storage.get(key)) !== undefined || (await storage.scan({ prefix, limit: 1 })).entries.length > 0) {
      throw new DeleteError("cleanup_incomplete", "Source index or revisions still exist")
    }
    return { id, deleted: true, revisionsRemoved: removed }
  } catch (error) {
    if (error instanceof DeleteError) throw error
    throw new DeleteError(
      "cleanup_incomplete",
      "Source is no longer listed, but stored revisions need cleanup; retry Delete by ID",
    )
  }
}
