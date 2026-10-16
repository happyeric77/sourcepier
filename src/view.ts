/** Parsing and validation for Source browse, view, edit and lifecycle receipts. */

export type SourcesAction = { mode: "browse" } | { mode: "add"; file?: string }

export function sourcesCommand(raw?: string): SourcesAction {
  const input = (raw ?? "").trim()
  if (!input || input === "browse" || input === "list") return { mode: "browse" }
  if (input === "add" || input === "import") return { mode: "add" }
  const path = input.startsWith("add ")
    ? input.slice(4).trim()
    : input.startsWith("import ")
      ? input.slice(7).trim()
      : input
  if (
    path.length >= 2 &&
    ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))
  ) {
    return { mode: "add", file: path.slice(1, -1) }
  }
  return { mode: "add", file: path || undefined }
}

export interface BrowserSource {
  id: string
  title: string
  revision: number
  format: "markdown" | "text"
  description?: string
}

export interface PreviewSource extends BrowserSource {
  content: string
  instanceId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sourceInfo(value: unknown): BrowserSource {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    (value.format !== "markdown" && value.format !== "text") ||
    (value.description !== undefined && typeof value.description !== "string")
  ) {
    throw new Error("Invalid Sources response")
  }
  return {
    id: value.id,
    title: value.title,
    revision: value.revision as number,
    format: value.format,
    ...(value.description === undefined ? {} : { description: value.description as string }),
  }
}

export function parseSourcesList(raw: unknown): { sources: BrowserSource[]; truncated: boolean } {
  if (!isRecord(raw) || !Array.isArray(raw.sources) || typeof raw.truncated !== "boolean") {
    throw new Error("Invalid Sources list response")
  }
  return { sources: raw.sources.map(sourceInfo), truncated: raw.truncated }
}

export function parsePreview(raw: unknown, expectedID: string): PreviewSource {
  const info = sourceInfo(raw)
  if (
    info.id !== expectedID ||
    !isRecord(raw) ||
    typeof raw.content !== "string" ||
    typeof raw.instanceId !== "string" ||
    !raw.instanceId
  ) {
    throw new Error("Invalid Sources preview response")
  }
  return { ...info, content: raw.content, instanceId: raw.instanceId }
}

export function parseSavedSource(raw: unknown, expectedID: string): { id: string; revision: number; changed: boolean } {
  if (
    !isRecord(raw) ||
    raw.id !== expectedID ||
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1 ||
    raw.revision > 999999 ||
    typeof raw.changed !== "boolean"
  )
    throw new Error("Invalid Source Save response; reload before retrying")
  return { id: expectedID, revision: raw.revision, changed: raw.changed }
}

export function parseDeletedSource(raw: unknown, expectedID: string): { id: string; revisionsRemoved: number } {
  if (
    !isRecord(raw) ||
    raw.id !== expectedID ||
    raw.deleted !== true ||
    typeof raw.revisionsRemoved !== "number" ||
    !Number.isSafeInteger(raw.revisionsRemoved) ||
    raw.revisionsRemoved < 0
  )
    throw new Error("Invalid Source Delete response; refresh Sources")
  return { id: expectedID, revisionsRemoved: raw.revisionsRemoved }
}

export function parseExportedSource(
  raw: unknown,
  expectedID: string,
): { id: string; path: string; revision: number; bytes: number } {
  if (
    !isRecord(raw) ||
    raw.id !== expectedID ||
    typeof raw.path !== "string" ||
    !raw.path ||
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1 ||
    raw.revision > 999999 ||
    typeof raw.bytes !== "number" ||
    !Number.isSafeInteger(raw.bytes) ||
    raw.bytes < 0
  )
    throw new Error("Invalid Source Export response; verify output file")
  return { id: expectedID, path: raw.path, revision: raw.revision, bytes: raw.bytes }
}

/** Do not render embedded terminal control codes as active UI labels. */
export function safeLabel(value: string, length = 100): string {
  return Array.from(value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim())
    .slice(0, length)
    .join("")
}
