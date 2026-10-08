/**
 * File-state-keyed cache of parsed JSONL session files.
 *
 * Session JSONLs are append-only (Claude/Codex rotate to NEW files instead
 * of rewriting), but replacements and rewrites are possible. Size, mtime,
 * ctime, device and inode find a candidate, and a content hash confirms it
 * (metadata alone misses a same-size rewrite); a changing read is never cached.
 * A file that grew past a cached state is parsed from the old end only when
 * its old bytes still hash to the cached digest.
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
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ChatMessage } from '@shared/types'
import { createMainLogger } from '../logger'
import { retainedJsonBytes } from './jsonl-memory'
import { JsonlParser } from './jsonl-parser'

const log = createMainLogger('agent:jsonl-cache')

const MAX_ENTRIES = 24
// Count retained messages, not ignored tool-result records in the raw file.
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
// Every open hashes each copy in full; 64 KiB reads made that 4x slower.
const READ_CHUNK_BYTES = 1024 * 1024

interface CacheEntry {
  mtimeMs: number
  size: number
  ctimeMs: number
  ino: number
  dev: number
  digest: string
  /** The cached bytes end on a line break, so new bytes start a new line. */
  endsWithNewline: boolean
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
  return (await loadJsonlSnapshot(filePath, source, timing, true, []))?.messages ?? null
}

/**
 * Parse copies of ONE session (profile copies of the same `<id>.jsonl`),
 * most complete first. A smaller copy whose bytes hash equal to the same-length
 * prefix of the first one holds no line the first does not, so it is skipped
 * instead of parsed. Anything not proven a prefix is parsed as before.
 * Returns one message array per copy that was parsed, in input order.
 */
export async function loadJsonlCopies(
  filePaths: readonly string[],
  source: 'claude-code' | 'codex',
  timing?: ChatLoadTiming,
): Promise<Array<{ path: string; messages: ChatMessage[] }>> {
  const [first, ...rest] = filePaths
  if (!first) return []
  const sizes = new Map<string, number>()
  for (const path of rest) {
    const st = await statOrNull(path)
    if (st) sizes.set(path, st.size)
  }
  const out: Array<{ path: string; messages: ChatMessage[] }> = []
  const head = await loadJsonlSnapshot(first, source, timing, true, [...sizes.values()])
  if (head) out.push({ path: first, messages: head.messages })
  for (const path of rest) {
    if (head && sizes.has(path)) {
      const copy = await hashFile(path, [])
      const prefix = copy && head.prefixes.get(copy.size)
      if (prefix && prefix === copy.digest) {
        if (timing) timing.prefixSkips += 1
        continue
      }
    }
    const messages = await loadJsonlCached(path, source, timing)
    if (messages) out.push({ path, messages })
  }
  return out
}

interface Snapshot {
  messages: ChatMessage[]
  /** sha256 of the first N bytes, for each requested N the file reaches. */
  prefixes: Map<number, string>
}

async function loadJsonlSnapshot(
  filePath: string,
  source: 'claude-code' | 'codex',
  timing: ChatLoadTiming | undefined,
  retry: boolean,
  prefixSizes: number[],
  append = true,
): Promise<Snapshot | null> {
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
  // on Windows), so a hit also re-hashes the bytes. That skips the parse,
  // which is most of the cost.
  const hashed = hit && sameState(hit, st) ? await hashFile(filePath, prefixSizes) : null
  if (hit && hashed?.digest === hit.digest) {
    const now = await statOrNull(filePath)
    if (!now) return null
    if (sameState(hit, now)) {
      // LRU bump: re-insert to move to the back of the eviction order.
      cache.delete(key)
      cache.set(key, hit)
      if (timing) timing.cacheHits += 1
      return { messages: hit.messages, prefixes: hashed.prefixes }
    }
  }

  // The open chat's transcript grows every turn. When it grew past a cached
  // state that ended on a line break, parse only the new bytes, and only once
  // the old bytes hash to the cached digest. Anything else parses in full.
  const base = append && hit?.endsWithNewline && hit.ino === st.ino && hit.dev === st.dev && st.size > hit.size
    ? hit
    : undefined
  const appendFrom = base?.size ?? 0
  let messages: ChatMessage[]
  let digest: string
  let prefixes: Map<number, string>
  let endsWithNewline = false
  try {
    const readStart = performance.now()
    let parseMs = 0
    messages = []
    const parser = new JsonlParser((msg) => messages.push(msg), source)
    const hash = new PrefixHasher(base ? [...prefixSizes, appendFrom] : prefixSizes)
    const decoder = new StringDecoder('utf8')
    for await (const raw of createReadStream(filePath, { highWaterMark: READ_CHUNK_BYTES })) {
      const chunk = raw as Buffer
      const skip = Math.min(chunk.length, Math.max(0, appendFrom - hash.size))
      hash.update(chunk)
      if (chunk.length > 0) endsWithNewline = chunk[chunk.length - 1] === 0x0a
      if (skip === chunk.length) continue
      const parseStart = performance.now()
      parser.feed(decoder.write(chunk.subarray(skip)))
      parseMs += performance.now() - parseStart
    }
    digest = hash.digest()
    prefixes = hash.prefixes
    if (base && prefixes.get(appendFrom) !== base.digest) {
      log.info('session jsonl changed before its cached end, parsing it in full', { filePath })
      return await loadJsonlSnapshot(filePath, source, timing, retry, prefixSizes, false)
    }
    const flushStart = performance.now()
    parser.feed(decoder.end())
    parser.flush()
    parseMs += performance.now() - flushStart
    if (timing) {
      timing.readMs += performance.now() - readStart - parseMs
      timing.parseMs += parseMs
      timing.diskBytes += st.size - appendFrom
      timing.diskLines += parser.lineCount
    }
    const after = await stat(filePath)
    if (!sameState(st, after)) {
      log.warn('session jsonl changed during read', { filePath, retry })
      return retry ? loadJsonlSnapshot(filePath, source, timing, false, prefixSizes, append) : null
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
  const retainedBytes = (base?.retainedBytes ?? 0) + parsedBytes
  cache.set(key, { retainedBytes, mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs, ino: st.ino, dev: st.dev, digest, endsWithNewline, messages })
  totalBytes += retainedBytes
  evict()
  return { messages, prefixes }
}

type FileState = Pick<CacheEntry, 'mtimeMs' | 'size' | 'ctimeMs' | 'ino' | 'dev'>

function sameState(a: FileState, b: FileState): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev
}

/** A file that vanished after its hash is a miss, not a rejected load. */
async function statOrNull(filePath: string): Promise<FileState | null> {
  try {
    return await stat(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') log.info('session jsonl removed after its cache check', { filePath })
    else log.warn('stat failed for session jsonl', { filePath, err })
    return null
  }
}

async function hashFile(
  filePath: string,
  prefixSizes: number[],
): Promise<{ digest: string; size: number; prefixes: Map<number, string> } | null> {
  const hash = new PrefixHasher(prefixSizes)
  try {
    for await (const chunk of createReadStream(filePath, { highWaterMark: READ_CHUNK_BYTES })) hash.update(chunk as Buffer)
  } catch (err) {
    log.warn('session jsonl hash failed', { filePath, err })
    return null
  }
  return { size: hash.size, digest: hash.digest(), prefixes: hash.prefixes }
}

/** sha256 of a byte stream, plus the digest of each requested prefix length. */
export class PrefixHasher {
  readonly prefixes = new Map<number, string>()
  size = 0
  private readonly hash = createHash('sha256')
  private readonly pending: number[]

  constructor(prefixSizes: readonly number[]) {
    this.pending = [...new Set(prefixSizes)].sort((a, b) => a - b)
    this.take()
  }

  update(chunk: Buffer): void {
    let used = 0
    while (this.pending.length > 0 && this.pending[0] <= this.size + chunk.length - used) {
      const cut = this.pending[0] - this.size
      this.hash.update(chunk.subarray(used, used + cut))
      this.size += cut
      used += cut
      this.take()
    }
    this.hash.update(chunk.subarray(used))
    this.size += chunk.length - used
  }

  digest(): string {
    return this.hash.digest('hex')
  }

  private take(): void {
    while (this.pending[0] === this.size) {
      this.prefixes.set(this.size, this.hash.copy().digest('hex'))
      this.pending.shift()
    }
  }
}

/** Test seam. */
export function clearJsonlCache(): void {
  cache.clear()
  totalBytes = 0
}
