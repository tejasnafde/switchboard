/**
 * (mtime, size)-keyed cache of parsed JSONL session files.
 *
 * Session JSONLs are append-only (Claude/Codex rotate to NEW files instead
 * of rewriting), so `(mtimeMs, size)` identifies a snapshot; size is cheap
 * insurance against coarse mtime granularity. Every session open used to
 * re-read and re-parse the full transcript from scratch - tens of MB for
 * long compaction-rotated threads - on every sidebar click.
 *
 * Bounded LRU: parsed histories can be large (base64 images ride along), so
 * only the most recently used files stay resident.
 *
 * Callers MUST NOT mutate the returned array - it is shared across hits.
 */
import { stat, readFile } from 'node:fs/promises'
import type { ChatMessage } from '@shared/types'
import { createMainLogger } from '../logger'
import { JsonlParser } from './jsonl-parser'

const log = createMainLogger('agent:jsonl-cache')

const MAX_ENTRIES = 24
// Entries carry base64 image bodies, so a count cap alone can pin hundreds
// of MB. File size is a good proxy for parsed footprint (base64 dominates
// both), and it's already statted.
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

interface CacheEntry {
  mtimeMs: number
  size: number
  messages: ChatMessage[]
}

const cache = new Map<string, CacheEntry>() // Map insertion order = LRU order
let totalBytes = 0

function evict(): void {
  while (cache.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = cache.entries().next().value
    if (!oldest) break
    cache.delete(oldest[0])
    totalBytes -= oldest[1].size
  }
}

/**
 * Parse `filePath` as a session JSONL, using the cached result when the
 * file is unchanged. Returns null when the file doesn't exist or can't be
 * read - replaces the throw-based miss path in fragment loops, which probe
 * every candidate profile dir and expect misses.
 */
export async function loadJsonlCached(
  filePath: string,
  source: 'claude-code' | 'codex',
): Promise<ChatMessage[] | null> {
  let st
  try {
    st = await stat(filePath)
  } catch (err) {
    // ENOENT is the expected probe miss; anything else (EPERM under macOS
    // TCC, EIO) must leave a trail - a silently "missing" transcript is
    // indistinguishable from a real permission problem otherwise.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('stat failed for session jsonl', { filePath, err })
    }
    return null
  }

  const key = `${source}\0${filePath}`
  const hit = cache.get(key)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    // LRU bump: re-insert to move to the back of the eviction order.
    cache.delete(key)
    cache.set(key, hit)
    return hit.messages
  }

  let messages: ChatMessage[]
  try {
    const raw = await readFile(filePath, 'utf-8')
    messages = []
    const parser = new JsonlParser((msg) => messages.push(msg), source)
    parser.feed(raw)
    parser.flush()
  } catch (err) {
    // A fragment that stats OK but fails to read (EACCES, deleted in the
    // stat→read window, EISDIR) must not reject a whole multi-fragment
    // load - callers skip null fragments and fall back to the DB mirror.
    log.warn('failed to read/parse session jsonl', { filePath, err })
    return null
  }

  const prev = cache.get(key)
  if (prev) {
    cache.delete(key)
    totalBytes -= prev.size
  }
  cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, messages })
  totalBytes += st.size
  evict()
  return messages
}

/** Test seam. */
export function clearJsonlCache(): void {
  cache.clear()
  totalBytes = 0
}
