import { createHash } from "node:crypto"
import { mkdir, rmdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

/**
 * Fail-closed single-machine writer coordination for the OpenCode SQLite KV.
 *
 * mkdir is atomic on a local filesystem; unlike a JS mutex it coordinates
 * independent OpenCode server processes using the same shared lock root.
 * An interrupted process leaves its lock in place: manual diagnosis is safer
 * than time-based "stale lock" theft that could overwrite a live writer.
 *
 * This is not a distributed lock, nor an authorization boundary. All plugin
 * writers on the database must use it; a server running old plugin code cannot
 * be made cooperative by the new version.
 */
export class WriterError extends Error {
  constructor(readonly code: "writer_busy" | "writer_unavailable") {
    super(code === "writer_busy" ? "Another SourcePier write is active; retry later" : "Safe Source writes are unavailable")
    this.name = "WriterError"
  }
}

const pending = new Set<string>()

export function writerLockPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const data = resolve(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode")
  const raw = env.OPENCODE_DB
  const database = raw === ":memory:" ? ":memory:" : raw ? resolve(data, raw) : join(data, "opencode.db")
  const root = env.OPENCODE_SOURCES_LOCK_ROOT
  if (root !== undefined && (!isAbsolute(root) || root.includes("\0"))) throw new WriterError("writer_unavailable")
  // Never place lock files inside an arbitrary Project worktree.
  const state = root ?? join(env.XDG_STATE_HOME || join(home, ".local", "state"), "opencode", "sources-locks")
  const digest = createHash("sha256").update(database).digest("hex").slice(0, 32)
  return join(state, digest + ".lock")
}

/** Atomic local-filesystem lease. No automatic stale-lock removal. */
export async function withWriterLock<T>(operation: () => Promise<T>, path = writerLockPath()): Promise<T> {
  if (pending.has(path)) throw new WriterError("writer_busy")
  pending.add(path)
  let locked = false
  try {
    try {
      // Parent is per-user state, outside the git worktree.
      const parent = dirname(path)
      await mkdir(parent, { recursive: true, mode: 0o700 })
      await mkdir(path, { mode: 0o700 })
      locked = true
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        throw new WriterError("writer_busy")
      }
      if (error instanceof WriterError) throw error
      throw new WriterError("writer_unavailable")
    }
    return await operation()
  } finally {
    if (locked) {
      try {
        await rmdir(path)
      } catch {
        // Fail closed: the retained lock blocks future writers. Never steal it.
      }
    }
    pending.delete(path)
  }
}
