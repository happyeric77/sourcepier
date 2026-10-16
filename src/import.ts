import { createHash, randomUUID } from "node:crypto"
import { open } from "node:fs/promises"
import { constants } from "node:fs"
import { basename, extname, isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode/plugin"
import { assertProjectID, bodyKey, MAX_BODY_BYTES, metaKey, SourcesError } from "./sources.js"

export type ImportErrorCode =
  "invalid_path" | "invalid_markdown" | "already_exists" | "storage_unavailable" | "project_unresolved"

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ImportError"
  }
}

type ImportStorage = Pick<Plugin.Context["storage"], "get" | "set">

// Prevent reentrant imports in this process; the RPC also uses the shared writer lock.
const importing = new Set<string>()

/** Stable, filesystem-independent, safe Source ID; non-ASCII names get a short deterministic suffix. */
export function sourceIDForFilename(filename: string): string {
  const stem = filename.replace(/\.(md|markdown)$/i, "")
  const ascii = stem
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "")
  if (ascii) return ascii
  return "source-" + createHash("sha256").update(stem).digest("hex").slice(0, 12)
}

/** Resolve against the server-side project directory, never a TUI client's arbitrary cwd. */
export function resolveImportPath(file: string, directory: string): string {
  const text = file.trim()
  if (!text || text.includes("\0")) throw new ImportError("invalid_path", "Choose a Markdown file")
  const expanded = text === "~" ? homedir() : text.startsWith("~/") ? resolve(homedir(), text.slice(2)) : text
  return isAbsolute(expanded) ? expanded : resolve(directory, expanded)
}

export async function loadMarkdown(file: string): Promise<string> {
  if (![".md", ".markdown"].includes(extname(file).toLowerCase())) {
    throw new ImportError("invalid_path", "Only .md and .markdown files are supported")
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    throw new ImportError("invalid_path", "Cannot open the selected Markdown file")
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new ImportError("invalid_path", "Import requires a regular Markdown file")
    if (info.size > MAX_BODY_BYTES) {
      throw new ImportError("invalid_markdown", "Markdown exceeds the 256 KiB S2 limit")
    }
    // Bound the bytes read even if the file grows after stat().
    const buffer = Buffer.alloc(MAX_BODY_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    if (length > MAX_BODY_BYTES) {
      throw new ImportError("invalid_markdown", "Markdown exceeds the 256 KiB S2 limit")
    }
    let content: string
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length))
    } catch {
      throw new ImportError("invalid_markdown", "Markdown must be valid UTF-8")
    }
    if (!content.trim()) throw new ImportError("invalid_markdown", "Markdown is empty")
    return content
  } catch (error) {
    if (error instanceof ImportError) throw error
    throw new ImportError("invalid_path", "Cannot read the selected Markdown file")
  } finally {
    await handle.close()
  }
}

/**
 * Copy a Markdown snapshot into project-scoped OpenCode KV.
 * No files are written to the project directory. No existing Source is replaced.
 */
export async function importMarkdown(
  storage: ImportStorage,
  projectID: string,
  directory: string,
  filename: string,
): Promise<{ id: string; title: string; revision: number }> {
  try {
    assertProjectID(projectID)
  } catch (error) {
    if (error instanceof SourcesError) throw new ImportError("project_unresolved", "A Project is required")
    throw error
  }
  const file = resolveImportPath(filename, directory)
  const title = basename(file).replace(/\.(md|markdown)$/i, "")
  if (!title.trim()) throw new ImportError("invalid_path", "Markdown filename needs a nonempty title")
  if (title.length > 200) throw new ImportError("invalid_path", "Markdown filename title exceeds 200 characters")
  const id = sourceIDForFilename(basename(file))
  const key = metaKey(projectID, id)
  if (importing.has(key)) throw new ImportError("already_exists", "This Source is already being imported")
  importing.add(key)
  try {
    let prior: unknown
    try {
      prior = await storage.get(key)
    } catch {
      throw new ImportError("storage_unavailable", "SourcePier storage is unavailable")
    }
    if (prior !== undefined) throw new ImportError("already_exists", "Source already exists; no file was overwritten")
    const content = await loadMarkdown(file)
    const revision = 1
    const revisionKey = bodyKey(projectID, id, revision)
    // Never overwrite an orphaned immutable body from an interrupted import.
    try {
      if ((await storage.get(revisionKey)) !== undefined) {
        throw new ImportError("already_exists", "A pending Source revision already exists; no overwrite performed")
      }
      const now = new Date().toISOString()
      await storage.set(revisionKey, { schemaVersion: 1, content })
      // Publish the metadata pointer only after the complete body has been stored.
      await storage.set(key, {
        schemaVersion: 1,
        id,
        projectID,
        title,
        description: "Imported Markdown document",
        format: "markdown",
        revision,
        bodyKey: revisionKey,
        createdAt: now,
        updatedAt: now,
        instanceId: randomUUID(),
      })
    } catch (error) {
      if (error instanceof ImportError) throw error
      throw new ImportError("storage_unavailable", "SourcePier storage is unavailable")
    }
    return { id, title, revision }
  } finally {
    importing.delete(key)
  }
}
