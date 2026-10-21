/**
 * File-state-keyed cache of parsed JSONL session files.
 *
 * Session JSONLs are append-only (Claude/Codex rotate to NEW files instead
 * of rewriting), but replacements and rewrites are possible. Size, mtime,
 * ctime, device and inode find a candidate, and a hash of the last 64 KiB
 * before the cached end confirms it (metadata alone misses a same-size
 * rewrite); a changing read is never cached. A file that grew past a cached
 * state is parsed from the old end only when that guard still matches, so a
 * reopen reads the guard and the new bytes, never the whole file.
 * ponytail: a rewrite that keeps every stat field and the last 64 KiB is
 * served stale; hash the whole file off the open path if that ever happens.
 *
 * Bounded LRU: parsed histories can be large (base64 images ride along), so
 * only the most recently used files stay resident.
 *
 * Callers MUST NOT mutate the returned array - it is shared across hits.
 */
import type { ChatLoadTiming } from '@shared/perf-chat'
import { open, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ChatMessage } from '@shared/types'
import { createMainLogger } from '../logger'
import { retainedJsonBytes } from './jsonl-memory'
import { JsonlParser } from './jsonl-parser'

const log = createMainLogger('agent:jsonl-cache')

// A long chat brings one entry per subagent transcript (16 seen), so a small
// cap evicted the session's own head when the user switched between two chats.
const MAX_ENTRIES = 256
// Count retained messages, not ignored tool-result records in the raw file.
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
// A prefix proof hashes a copy in full; 64 KiB reads made that 4x slower.
const READ_CHUNK_BYTES = 1024 * 1024
/** Bytes before the cached end that must still match for a hit or an append. */
export const GUARD_BYTES = 64 * 1024

interface CacheEntry extends FileState {
  guard: string
  /** The cached bytes end on a line break, so new bytes start a new line. */
  endsWithNewline: boolean
  messages: ChatMessage[]
  retainedBytes: number
  /** New on every full parse; an append keeps it, so a copy proven a prefix stays proven. */
  lineage: number
}

const cache = new Map<string, CacheEntry>() // Map insertion order = LRU order
let totalBytes = 0
let nextLineage = 1
/** Copies proven a byte prefix of a head copy, by copy path. */
const provenPrefixes = new Map<string, { copy: FileState; head: string; lineage: number }>()

/** Oldest first, never `keep`: one chat over the byte budget must still hit on its next open. */
function evict(keep: string): void {
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) break
    if (key === keep) continue
    cache.delete(key)
    totalBytes -= entry.retainedBytes
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
  return (await loadJsonlSnapshot(filePath, source, timing, true))?.messages ?? null
}

/**
 * Parse copies of ONE session (profile copies of the same `<id>.jsonl`),
 * most complete first. A smaller copy whose bytes hash equal to the same-length
 * prefix of the first one holds no line the first does not, so it is skipped
 * instead of parsed. The proof is kept while the copy is unchanged and the
 * first copy only grew. Anything not proven a prefix is parsed as before.
 * Returns one message array per copy that was parsed, in input order.
 */
export async function loadJsonlCopies(
  filePaths: readonly string[],
  source: 'claude-code' | 'codex',
  timing?: ChatLoadTiming,
): Promise<Array<{ path: string; messages: ChatMessage[] }>> {
  const [first, ...rest] = filePaths
  if (!first) return []
  const out: Array<{ path: string; messages: ChatMessage[] }> = []
  const head = await loadJsonlSnapshot(first, source, timing, true)
  if (head) out.push({ path: first, messages: head.messages })
  for (const path of rest) {
    const st = head ? await statOrNull(path) : null
    if (head && st && (await provenPrefix(path, st, first, head))) {
      if (timing) timing.prefixSkips += 1
      continue
    }
    const messages = await loadJsonlCached(path, source, timing)
    if (messages) out.push({ path, messages })
  }
  return out
}

async function provenPrefix(path: string, st: FileState, headPath: string, head: CacheEntry): Promise<boolean> {
  const memo = provenPrefixes.get(path)
  if (memo && memo.head === headPath && memo.lineage === head.lineage && sameState(memo.copy, st)) return true
  if (st.size > head.size) return false
  const copy = await hashRange(path, st.size)
  if (!copy || copy !== (await hashRange(headPath, st.size))) return false
  provenPrefixes.delete(path)
  provenPrefixes.set(path, { copy: st, head: headPath, lineage: head.lineage })
  if (provenPrefixes.size > MAX_ENTRIES) provenPrefixes.delete(provenPrefixes.keys().next().value!)
  return true
}

async function loadJsonlSnapshot(
  filePath: string,
  source: 'claude-code' | 'codex',
  timing: ChatLoadTiming | undefined,
  retry: boolean,
  append = true,
): Promise<CacheEntry | null> {
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
  // Metadata alone misses a same-size rewrite that keeps the old mtime (seen
  // on Windows), so a hit also checks the guard bytes. That skips the parse,
  // which is most of the cost.
  if (hit && sameState(hit, st) && (await guardOf(filePath, hit.size)) === hit.guard) {
    const now = await statOrNull(filePath)
    if (!now) return null
    if (sameState(hit, now)) {
      // LRU bump: re-insert to move to the back of the eviction order.
      cache.delete(key)
      cache.set(key, hit)
      if (timing) timing.cacheHits += 1
      return hit
    }
  }

  // The open chat's transcript grows every turn. When it grew past a cached
  // state that ended on a line break and the guard before the old end still
  // matches, parse only the new bytes. Anything else parses in full.
  const grew = append && hit?.endsWithNewline && hit.ino === st.ino && hit.dev === st.dev && st.size > hit.size
  const base = grew && (await guardOf(filePath, hit.size)) === hit.guard ? hit : undefined
  if (grew && !base) log.info('session jsonl changed before its cached end, parsing it in full', { filePath })
  const appendFrom = base?.size ?? 0
  let messages: ChatMessage[]
  let guard: string | null
  let endsWithNewline = false
  try {
    const readStart = performance.now()
    let parseMs = 0
    messages = []
    const parser = new JsonlParser((msg) => messages.push(msg), source)
    const decoder = new StringDecoder('utf8')
    let read = 0
    // `end` is inclusive; stopping at the stat'd size keeps a write landing
    // mid-read out of this parse (the state check below retries it).
    const chunks =
      st.size > appendFrom
        ? createReadStream(filePath, { start: appendFrom, end: st.size - 1, highWaterMark: READ_CHUNK_BYTES })
        : []
    for await (const raw of chunks) {
      const chunk = raw as Buffer
      read += chunk.length
      if (chunk.length > 0) endsWithNewline = chunk[chunk.length - 1] === 0x0a
      const parseStart = performance.now()
      parser.feed(decoder.write(chunk))
      parseMs += performance.now() - parseStart
    }
    const flushStart = performance.now()
    parser.feed(decoder.end())
    parser.flush()
    parseMs += performance.now() - flushStart
    if (timing) {
      timing.readMs += performance.now() - readStart - parseMs
      timing.parseMs += parseMs
      timing.diskBytes += read
      timing.diskLines += parser.lineCount
    }
    guard = await guardOf(filePath, st.size)
    const after = await stat(filePath)
    if (guard === null || read !== st.size - appendFrom || !sameState(st, after)) {
      log.warn('session jsonl changed during read', { filePath, retry })
      return retry ? loadJsonlSnapshot(filePath, source, timing, false, append) : null
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
  const parsedBytes = retainedJsonBytes(messages)
  if (base) messages = base.messages.concat(messages)
  const entry: CacheEntry = {
    retainedBytes: (base?.retainedBytes ?? 0) + parsedBytes,
    mtimeMs: st.mtimeMs,
    size: st.size,
    ctimeMs: st.ctimeMs,
    ino: st.ino,
    dev: st.dev,
    guard,
    endsWithNewline,
    messages,
    lineage: base?.lineage ?? nextLineage++,
  }
  cache.set(key, entry)
  totalBytes += entry.retainedBytes
  evict(key)
  return entry
}

interface FileState {
  mtimeMs: number
  size: number
  ctimeMs: number
  ino: number
  dev: number
}

function sameState(a: FileState, b: FileState): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev
}

/** A file that vanished after its hash is a miss, not a rejected load. */
async function statOrNull(filePath: string): Promise<FileState | null> {
  try {
    return await stat(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      log.info('session jsonl removed after its cache check', { filePath })
    else log.warn('stat failed for session jsonl', { filePath, err })
    return null
  }
}

/** sha256 of the `GUARD_BYTES` before `end`, plus `end` itself; null when the file is shorter. */
async function guardOf(filePath: string, end: number): Promise<string | null> {
  const start = Math.max(0, end - GUARD_BYTES)
  const buffer = Buffer.alloc(end - start)
  let file
  try {
    file = await open(filePath, 'r')
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    if (bytesRead !== buffer.length) return null
  } catch (err) {
    log.warn('session jsonl guard read failed', { filePath, err })
    return null
  } finally {
    await file?.close()
  }
  return createHash('sha256').update(buffer).update(String(end)).digest('hex')
}

/** sha256 of the first `size` bytes, or null when the file is shorter or unreadable. */
async function hashRange(filePath: string, size: number): Promise<string | null> {
  const hash = createHash('sha256')
  let read = 0
  try {
    if (size > 0) {
      for await (const chunk of createReadStream(filePath, { end: size - 1, highWaterMark: READ_CHUNK_BYTES })) {
        hash.update(chunk as Buffer)
        read += (chunk as Buffer).length
      }
    }
  } catch (err) {
    log.warn('session jsonl hash failed', { filePath, err })
    return null
  }
  return read === size ? hash.digest('hex') : null
}

/** Test seam. */
export function clearJsonlCache(): void {
  cache.clear()
  provenPrefixes.clear()
  totalBytes = 0
}
