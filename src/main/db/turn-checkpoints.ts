/**
 * The baseline of each running turn's diff cards (a git tree id, see
 * `git/checkpoint.ts`), so a backend that stops mid-turn can still show what
 * that turn changed when the chat starts again.
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { StoredTurnCheckpoint, TurnCheckpointStore } from '../provider/checkpoint-tracker'
import { resolveRootThreadId } from './conversations'
import { createMainLogger } from '../logger'

const log = createMainLogger('db:turn-checkpoints')

/** Rows written by an earlier process are the turns a restart interrupted. */
const LAUNCH = randomUUID()

export function ensureTurnCheckpointSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_checkpoints (
      thread_id TEXT PRIMARY KEY,
      turn_id   TEXT NOT NULL,
      tree      TEXT NOT NULL,
      repo_root TEXT NOT NULL,
      written   TEXT NOT NULL,
      launch    TEXT NOT NULL
    );
  `)
}

/**
 * Keyed by the root conversation id (`root`), since the chat may start again
 * under its first id after Claude rotated its session id.
 */
export function sqliteTurnCheckpointStore(
  db: () => Database.Database,
  root: (threadId: string) => string = resolveRootThreadId,
): TurnCheckpointStore {
  type Row = { turn_id: string; tree: string; repo_root: string; written: string }
  return {
    save(threadId, cp) {
      db()
        .prepare(
          'INSERT OR REPLACE INTO turn_checkpoints (thread_id, turn_id, tree, repo_root, written, launch) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(root(threadId), cp.turnId, cp.tree, cp.repoRoot, JSON.stringify(cp.written), LAUNCH)
    },
    remove(threadId) {
      db().prepare('DELETE FROM turn_checkpoints WHERE thread_id = ?').run(root(threadId))
    },
    takeEarlier(threadId) {
      const d = db()
      const key = root(threadId)
      return d.transaction((): StoredTurnCheckpoint | null => {
        const row = d
          .prepare('SELECT turn_id, tree, repo_root, written FROM turn_checkpoints WHERE thread_id = ? AND launch != ?')
          .get(key, LAUNCH) as Row | undefined
        if (!row) return null
        d.prepare('DELETE FROM turn_checkpoints WHERE thread_id = ?').run(key)
        // Unreadable means nothing counts as the agent's: every card shows without Reject.
        let written: unknown = []
        try {
          written = JSON.parse(row.written)
        } catch (err) {
          log.warn('stored written paths are not JSON', { threadId: key, bytes: Buffer.byteLength(row.written), err })
        }
        return {
          turnId: row.turn_id,
          tree: row.tree,
          repoRoot: row.repo_root,
          written: Array.isArray(written) ? written.filter((p): p is string => typeof p === 'string') : [],
        }
      })()
    },
  }
}
