/**
 * File-state-keyed cache of parsed JSONL session files.
 *
 * Session JSONLs are append-only (Claude/Codex rotate to NEW files instead
 * of rewriting), but replacements and rewrites are possible. Size, mtime,
 * ctime, device and inode identify a snapshot; a changing read is never cached.
 * Every session open used to
 * re-read and re-parse the full transcript from scratch - tens of MB for
 * long compaction-rotated threads - on every sidebar click.
 *
 * Bounded LRU: parsed histories can be large (base64 images ride along), so
 * only the most recently used files stay resident.
 *
 * Callers MUST NOT mutate the returned array - it is shared across hits.
 */
import type { ChatLoadTiming } from '@shared/perf-chat'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import type { ChatMessage } from '@shared/types'
import { createMainLogger } from '../logger'
import { retainedJsonBytes } from './jsonl-memory'
import { JsonlParser } from './jsonl-parser'

const log = createMainLogger('agent:jsonl-cache')

const MAX_ENTRIES = 24
// Count retained messages, not ignored tool-result records in the raw file.
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

interface CacheEntry {
  mtimeMs: number
  size: number
  ctimeMs: number
  ino: number
  dev: number
  messages: ChatMessage[]
  retainedBytes: number
}

const cache = new Map<string, CacheEntry>() // Map insertion order = LRU order
let totalBytes = 0

function evict(): void {
  while (cache.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = cache.entries().next().value
    if (!oldest) break
    cache.delete(oldest[0])
    totalBytes -= oldest[1].retainedBytes
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
  timing?: ChatLoadTiming,
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
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ctimeMs === st.ctimeMs && hit.ino === st.ino && hit.dev === st.dev) {
    // LRU bump: re-insert to move to the back of the eviction order.
    cache.delete(key)
    cache.set(key, hit)
    if (timing) timing.cacheHits += 1
    return hit.messages
  }

  let messages: ChatMessage[]
  try {
    const readStart = performance.now()
    let parseMs = 0
    messages = []
    const parser = new JsonlParser((msg) => messages.push(msg), source)
    for await (const chunk of createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
      const parseStart = performance.now()
      parser.feed(chunk as string)
      parseMs += performance.now() - parseStart
    }
    const flushStart = performance.now()
    parser.flush()
    parseMs += performance.now() - flushStart
    if (timing) {
      timing.readMs += performance.now() - readStart - parseMs
      timing.parseMs += parseMs
      timing.diskBytes += st.size
      timing.diskLines += parser.lineCount
    }
    const after = await stat(filePath)
    if (st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs || st.ino !== after.ino || st.dev !== after.dev) {
      return messages
    }
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
    totalBytes -= prev.retainedBytes
  }
  const retainedBytes = retainedJsonBytes(messages)
  cache.set(key, { retainedBytes, mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs, ino: st.ino, dev: st.dev, messages })
  totalBytes += retainedBytes
  evict()
  return messages
}

/** Test seam. */
export function clearJsonlCache(): void {
  cache.clear()
  totalBytes = 0
}
