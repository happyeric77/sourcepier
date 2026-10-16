/**
 * OpenTUI textarea normalizes CRLF to LF and drops an initial UTF-8 BOM on load.
 * Never compare its plainText directly with the canonical Source body.
 */
export function editorInitialValue(original: string): string {
  return original.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
}

/**
 * An unchanged editor must not create a revision or normalize the original.
 * On edits, preserve a leading BOM and homogeneous CRLF style. Mixed newline
 * documents deliberately normalize to LF on edit (not on untouched Save).
 */
export function draftToCanonical(original: string, draft: string): { content: string; changed: boolean } {
  const plain = editorInitialValue(original)
  if (draft === plain) return { content: original, changed: false }
  const body = draft.replace(/\r\n?/g, "\n")
  const withoutBOM = original.replace(/^\uFEFF/, "")
  const crlfOnly = withoutBOM.includes("\r\n") && !withoutBOM.replace(/\r\n/g, "").includes("\n") && !withoutBOM.replace(/\r\n/g, "").includes("\r")
  return {
    content: (original.startsWith("\uFEFF") ? "\uFEFF" : "") + (crlfOnly ? body.replace(/\n/g, "\r\n") : body),
    changed: true,
  }
}
