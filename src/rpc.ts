import { Rpc } from "@opencode/plugin/rpc"

/**
 * Project-scoped RPC using OpenCode's existing transport access control.
 * Agents have only read-only tools; RPC clients share normal OpenCode access.
 */
const emptyError = { type: "object", properties: {}, additionalProperties: false } as const
const sourceProperties = {
  id: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  format: { type: "string", enum: ["markdown", "text"] },
  revision: { type: "integer" },
} as const
const sourceSummary = {
  type: "object",
  properties: sourceProperties,
  required: ["id", "title", "format", "revision"],
  additionalProperties: false,
} as const
const readErrors = {
  project_unresolved: emptyError,
  source_not_found: emptyError,
  invalid_source_id: emptyError,
  source_unavailable: emptyError,
  storage_unavailable: emptyError,
} as const

// The SourcePier RPC ID matches the Server/TUI registration.
export const SourcesRPC = Rpc.define({
  id: "sourcepier",
  methods: {
    importMarkdown: {
      input: {
        type: "object",
        properties: { file: { type: "string", minLength: 1 } },
        required: ["file"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          revision: { type: "integer" },
        },
        required: ["id", "title", "revision"],
        additionalProperties: false,
      },
      errors: {
        invalid_path: emptyError,
        invalid_markdown: emptyError,
        already_exists: emptyError,
        storage_unavailable: emptyError,
        project_unresolved: emptyError,
      },
    },
    listSources: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          sources: { type: "array", items: sourceSummary },
          truncated: { type: "boolean" },
        },
        required: ["sources", "truncated"],
        additionalProperties: false,
      },
      errors: readErrors,
    },
    saveSource: {
      input: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          expectedRevision: { type: "integer", minimum: 1 },
          expectedInstance: { type: "string", minLength: 1 },
          content: { type: "string" },
        },
        required: ["id", "expectedRevision", "expectedInstance", "content"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          revision: { type: "integer" },
          changed: { type: "boolean" },
        },
        required: ["id", "revision", "changed"],
        additionalProperties: false,
      },
      errors: {
        invalid_source_id: emptyError,
        invalid_content: emptyError,
        source_not_found: emptyError,
        source_unavailable: emptyError,
        project_unresolved: emptyError,
        revision_conflict: emptyError,
        revision_exhausted: emptyError,
        publication_blocked: emptyError,
        writer_busy: emptyError,
        writer_unavailable: emptyError,
        storage_unavailable: emptyError,
      },
    },
    deleteSource: {
      input: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          expectedRevision: { type: "integer", minimum: 1 },
          expectedInstance: { type: "string", minLength: 1 },
        },
        required: ["id", "expectedRevision", "expectedInstance"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          deleted: { type: "boolean" },
          revisionsRemoved: { type: "integer" },
        },
        required: ["id", "deleted", "revisionsRemoved"],
        additionalProperties: false,
      },
      errors: {
        invalid_source_id: emptyError,
        project_unresolved: emptyError,
        source_not_found: emptyError,
        source_unavailable: emptyError,
        revision_conflict: emptyError,
        cleanup_incomplete: emptyError,
        storage_unavailable: emptyError,
        writer_busy: emptyError,
        writer_unavailable: emptyError,
      },
    },
    exportSource: {
      input: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
        },
        required: ["id", "path"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          revision: { type: "integer" },
          bytes: { type: "integer" },
        },
        required: ["id", "path", "revision", "bytes"],
        additionalProperties: false,
      },
      errors: {
        invalid_source_id: emptyError,
        project_unresolved: emptyError,
        source_not_found: emptyError,
        source_unavailable: emptyError,
        invalid_path: emptyError,
        already_exists: emptyError,
        write_failed: emptyError,
        storage_unavailable: emptyError,
      },
    },
    readSource: {
      input: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ...sourceProperties, content: { type: "string" }, instanceId: { type: "string", minLength: 1 } },
        required: ["id", "title", "format", "revision", "content", "instanceId"],
        additionalProperties: false,
      },
      errors: readErrors,
    },
  },
  events: {},
})
