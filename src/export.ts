import { open, unlink } from "node:fs/promises"
import { constants } from "node:fs"
import { extname } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { resolveImportPath } from "./import.js"
import { readSource, SourcesError } from "./sources.js"

type ExportStorage = Pick<Plugin.Context["storage"], "get">

export type ExportErrorCode =
  | "invalid_source_id"
  | "project_unresolved"
  | "source_not_found"
  | "source_unavailable"
  | "invalid_path"
  | "already_exists"
  | "write_failed"
  | "storage_unavailable"

export class ExportError extends Error {
  constructor(
    readonly code: ExportErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ExportError"
  }
}

/** Export exactly the current Markdown body; never update the Source KV. */
export async function exportSource(
  storage: ExportStorage,
  projectID: string,
  id: string,
  directory: string,
  destination: string,
): Promise<{ id: string; path: string; revision: number; bytes: number }> {
  let content: string
  let revision: number
  try {
    const source = await readSource(storage, projectID, id)
    if (source.format !== "markdown") throw new ExportError("invalid_path", "Only Markdown Sources can be exported")
    content = source.content
    revision = source.revision
  } catch (error) {
    if (error instanceof ExportError) throw error
    if (error instanceof SourcesError) {
      const code: ExportErrorCode =
        error.code === "PROJECT_UNRESOLVED"
          ? "project_unresolved"
          : error.code === "INVALID_SOURCE_ID"
            ? "invalid_source_id"
            : error.code === "SOURCE_NOT_FOUND"
              ? "source_not_found"
              : error.code === "DATA_INTEGRITY_ERROR" || error.code === "UNSUPPORTED_SCHEMA"
                ? "source_unavailable"
                : "storage_unavailable"
      throw new ExportError(code, "Cannot export this Project Source")
    }
    throw new ExportError("storage_unavailable", "Cannot read Project Source for export")
  }

  if (typeof destination !== "string" || !destination.trim() || destination.includes("\0")) {
    throw new ExportError("invalid_path", "Choose a destination Markdown file")
  }
  const path = resolveImportPath(destination, directory)
  if (![".md", ".markdown"].includes(extname(path).toLowerCase())) {
    throw new ExportError("invalid_path", "Export destination must be .md or .markdown")
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // O_EXCL refuses an existing destination, including a symlink.
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new ExportError("already_exists", "Destination already exists; choose another filename")
    }
    throw new ExportError("invalid_path", "Cannot create the destination Markdown file")
  }
  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
    return { id, path, revision, bytes: Buffer.byteLength(content, "utf8") }
  } catch {
    await handle.close().catch(() => {})
    await unlink(path).catch(() => {})
    throw new ExportError("write_failed", "Markdown export failed")
  } finally {
    await handle.close().catch(() => {})
  }
}
