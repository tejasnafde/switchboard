/**
 * Byte-offset index of a session JSONL, kept on disk, so a history window
 * parses only its own lines instead of the whole transcript.
 *
 * Per transcript message the index holds its id, role, timestamp and the byte
 * range of its line, plus the later result lines that change a tool call (an
 * error, a subagent's report). A parse of a slice plus those result lines
 * gives the messages a full parse gives. Only complete lines are indexed; a
 * last line with no line break yet is parsed on each open.
 *
 * Validation is the parse cache's append rule: the same inode and device, a
 * file at least as long as the indexed bytes, and an unchanged sha256 of the
 * 64 KiB before the indexed end (`guardOf`). Then only the bytes after that end
 * are parsed. Anything else indexes the file again from byte 0. A slice whose
 * messages do not match the index throws `StaleTranscriptIndexError`, and the
 * caller parses the transcript in full.
 *
 * The index also records which profile copies were proven a byte prefix of
 * its file (sha256 of the copy equals the same-length prefix). A proof holds
 * while the copy's stat is unchanged and the index was only appended to, so a
 * start after a restart hashes no copy again.
 */
import { closeSync, createReadStream, openSync, readSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ChatLoadTiming } from '@shared/perf-chat'
import type { ChatMessage } from '@shared/types'
import { createMainLogger } from '../logger'
import { userDataDir } from '../runtime'
import { guardOf, hashRange, sameState, statOrNull, type FileState } from './jsonl-cache'
import { JsonlParser, type JsonlSource } from './jsonl-parser'

const log = createMainLogger('agent:transcript-index')

const VERSION = 1
const MAX_IN_MEMORY = 64
const READ_CHUNK_BYTES = 1024 * 1024
/** Positions this close are read as one slice: one read beats many small ones. */
const SLICE_GAP = 64
/** An id the parser made up for a line without one; a new parse makes another. */
const GENERATED_ID = /^msg_\d+_\d+$/

export interface IndexedMessage {
  id: string
  role: ChatMessage['role']
  timestamp: number
}

interface TranscriptIndex {
  source: JsonlSource
  path: string
  /** The file's stat when `end` was indexed. */
  state: FileState
  /** Bytes indexed: complete lines only. */
  end: number
  guard: string
  messages: IndexedMessage[]
  starts: number[]
  ends: number[]
  /** Calls with no result yet, as `[id, name]`, so an append can still record theirs. */
  pending: Array<[string, string]>
  /** Result line byte ranges, by call id, of results that change their call. */
  results: Record<string, [number, number]>
  /** Copies proven a byte prefix of this file; an index from byte 0 starts with none. */
  prefixes: Array<{ path: string; state: FileState }>
}

/** One transcript as a window reads it. */
export interface IndexedTranscript {
  path: string
  /** Id, role and time of every message, in transcript order. */
  messages: readonly IndexedMessage[]
  /** The full messages at these positions of `messages`, in the order given. */
  materialize(positions: readonly number[]): ChatMessage[]
}

export class StaleTranscriptIndexError extends Error {
  constructor(
    readonly path: string,
    readonly source: JsonlSource,
  ) {
    super(`transcript index does not match ${path}`)
  }
}

const memory = new Map<string, TranscriptIndex>() // insertion order = LRU
const locks = new Map<string, Promise<unknown>>()
const writes = new Map<string, Promise<void>>()

/**
 * Index profile copies of ONE session, most complete first. A smaller copy
 * proven a byte prefix of the first is skipped; any other copy is indexed on
 * its own. Null when a copy that exists cannot be indexed: the caller then
 * parses the copies in full.
 */
export async function openIndexedCopies(
  paths: readonly string[],
  source: JsonlSource,
  timing: ChatLoadTiming,
): Promise<IndexedTranscript[] | null> {
  const [first, ...rest] = paths
  if (!first) return []
  const states = await Promise.all(rest.map((path) => statOrNull(path)))
  const head = await openIndex(
    first,
    source,
    timing,
    states.flatMap((st) => (st ? [st.size] : [])),
  )
  if (!head) return null
  const out = [head.transcript]
  for (const [at, path] of rest.entries()) {
    const st = states[at]
    if (!st) continue
    if (await provenPrefix(head, path, st, timing)) {
      timing.prefixSkips += 1
      continue
    }
    const copy = await openIndex(path, source, timing)
    if (!copy) return null
    out.push(copy.transcript)
  }
  return out
}

/** Drop a transcript's index after a slice did not match it. */
export async function forgetTranscriptIndex(path: string, source: JsonlSource): Promise<void> {
  const key = keyOf(path, source)
  memory.delete(key)
  await writes.get(key)
  await rm(indexFile(key), { force: true }).catch((err) =>
    log.warn('could not remove a stale transcript index', { path, err }),
  )
}

interface Opened {
  index: TranscriptIndex
  transcript: IndexedTranscript
  /** sha256 of the first N bytes, for each requested N, when this open read the file from byte 0. */
  digests: Map<number, string>
}

async function provenPrefix(head: Opened, path: string, st: FileState, timing: ChatLoadTiming): Promise<boolean> {
  const index = head.index
  if (index.prefixes.some((proof) => proof.path === path && sameState(proof.state, st))) return true
  if (st.size > index.state.size) return false
  const start = performance.now()
  const copy = await hashRange(path, st.size)
  const prefix = copy ? (head.digests.get(st.size) ?? (await hashRange(index.path, st.size))) : null
  timing.hashMs = (timing.hashMs ?? 0) + performance.now() - start
  if (!copy || copy !== prefix) return false
  // A proof past the indexed end would not survive a change to the unindexed tail.
  if (st.size <= index.end) {
    index.prefixes = [...index.prefixes.filter((proof) => proof.path !== path), { path, state: st }]
    persist(keyOf(index.path, index.source), index)
  }
  return true
}

async function openIndex(
  path: string,
  source: JsonlSource,
  timing: ChatLoadTiming,
  prefixSizes: readonly number[] = [],
): Promise<Opened | null> {
  const key = keyOf(path, source)
  const before = locks.get(key) ?? Promise.resolve()
  // Two opens of one file at once would append the same lines twice.
  const run = before.then(() => openUnlocked(key, path, source, timing, prefixSizes, true))
  locks.set(key, run)
  try {
    return await run
  } finally {
    if (locks.get(key) === run) locks.delete(key)
  }
}

async function openUnlocked(
  key: string,
  path: string,
  source: JsonlSource,
  timing: ChatLoadTiming,
  prefixSizes: readonly number[],
  retry: boolean,
): Promise<Opened | null> {
  try {
    const st = await statOrNull(path)
    if (!st) return null
    let base = memory.get(key) ?? (await readPersisted(key, path, source))
    if (
      base &&
      !(
        base.state.ino === st.ino &&
        base.state.dev === st.dev &&
        st.size >= base.end &&
        (await guardOf(path, base.end)) === base.guard
      )
    ) {
      log.info('session jsonl changed before its indexed end, indexing it again', { path })
      base = undefined
    }
    const scan = await scanLines(path, source, base, st.size, base ? [] : prefixSizes, timing)
    if (!scan) return null
    const guard = await guardOf(path, scan.end)
    const after = await statOrNull(path)
    if (guard === null || !after || !sameState(st, after)) {
      log.warn('session jsonl changed during index read', { path, retry })
      return retry ? openUnlocked(key, path, source, timing, prefixSizes, false) : null
    }
    const index: TranscriptIndex = base ?? {
      source,
      path,
      state: st,
      end: 0,
      guard,
      messages: [],
      starts: [],
      ends: [],
      pending: [],
      results: {},
      prefixes: [],
    }
    const changed = !base || scan.end !== base.end || !sameState(base.state, st)
    if (base) timing.indexHits = (timing.indexHits ?? 0) + 1
    // Appends only push, so a transcript handed out earlier keeps valid positions.
    index.messages.push(...scan.messages)
    index.starts.push(...scan.starts)
    index.ends.push(...scan.ends)
    Object.assign(index.results, scan.results)
    index.pending = scan.pending
    index.state = st
    index.end = scan.end
    index.guard = guard
    memory.delete(key)
    memory.set(key, index)
    if (memory.size > MAX_IN_MEMORY) memory.delete(memory.keys().next().value!)
    if (changed) persist(key, index)
    return { index, transcript: transcriptOf(index, scan.tail, timing), digests: scan.digests }
  } catch (err) {
    log.warn('failed to index session jsonl', { path, err })
    return null
  }
}

interface Scan {
  end: number
  messages: IndexedMessage[]
  starts: number[]
  ends: number[]
  results: Record<string, [number, number]>
  pending: Array<[string, string]>
  /** Messages of a last line with no line break yet. */
  tail: ChatMessage[]
  digests: Map<number, string>
}

/** Parse the complete lines from the indexed end (or byte 0) to `size`. */
async function scanLines(
  path: string,
  source: JsonlSource,
  base: TranscriptIndex | undefined,
  size: number,
  prefixSizes: readonly number[],
  timing: ChatLoadTiming,
): Promise<Scan | null> {
  const from = base?.end ?? 0
  const scan: Scan = {
    end: from,
    messages: [],
    starts: [],
    ends: [],
    results: {},
    pending: [],
    tail: [],
    digests: new Map(),
  }
  let lineStart = from
  let lineEnd = from
  const parser = new JsonlParser((message) => {
    scan.messages.push({ id: message.id, role: message.role, timestamp: message.timestamp })
    scan.starts.push(lineStart)
    scan.ends.push(lineEnd)
  }, source)
  if (base) parser.seedToolCalls(base.pending.map(([id, name]) => ({ id, name, input: '' })))
  parser.onToolResult = (id) => {
    scan.results[id] = [lineStart, lineEnd]
  }
  const hasher = from === 0 ? new PrefixDigests(prefixSizes.filter((at) => at <= size)) : null
  const readStart = performance.now()
  let parseMs = 0
  let hashMs = 0
  let read = 0
  let carry: Buffer | null = null
  let carryAt = from
  if (size > from) {
    for await (const raw of createReadStream(path, { start: from, end: size - 1, highWaterMark: READ_CHUNK_BYTES })) {
      const chunk = raw as Buffer
      if (hasher) {
        const hashStart = performance.now()
        hasher.update(chunk)
        hashMs += performance.now() - hashStart
      }
      read += chunk.length
      const buffer: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
      const parseStart = performance.now()
      let at = 0
      for (let nl = buffer.indexOf(0x0a, at); nl !== -1; nl = buffer.indexOf(0x0a, at)) {
        lineStart = carryAt + at
        lineEnd = carryAt + nl + 1
        parser.line(buffer.toString('utf8', at, nl))
        at = nl + 1
      }
      parseMs += performance.now() - parseStart
      carry = at < buffer.length ? buffer.subarray(at) : null
      carryAt += at
    }
  }
  if (read !== size - from) return null
  scan.end = carryAt
  scan.pending = parser.pendingToolCalls().map((call) => [call.id, call.name])
  if (carry) {
    const tail = new JsonlParser((message) => scan.tail.push(message), source)
    tail.line(carry.toString('utf8'))
  }
  if (hasher) scan.digests = hasher.digests
  timing.readMs += performance.now() - readStart - parseMs - hashMs
  timing.parseMs += parseMs
  timing.hashMs = (timing.hashMs ?? 0) + hashMs
  timing.diskBytes += read
  timing.diskLines += parser.lineCount
  return scan
}

/** sha256 of the first N bytes of a stream, for each N, in one pass. */
class PrefixDigests {
  readonly digests = new Map<number, string>()
  private readonly hash = createHash('sha256')
  private readonly at: number[]
  private offset = 0

  constructor(sizes: readonly number[]) {
    this.at = [...new Set(sizes)].sort((a, b) => a - b)
    this.take()
  }

  update(chunk: Buffer): void {
    if (this.at.length === 0) return
    const start = this.offset
    const end = start + chunk.length
    while (this.at.length > 0 && this.at[0] <= end) {
      this.hash.update(chunk.subarray(this.offset - start, this.at[0] - start))
      this.offset = this.at[0]
      this.take()
    }
    this.hash.update(chunk.subarray(this.offset - start))
    this.offset = end
  }

  /** Record every size the hash has reached. */
  private take(): void {
    while (this.at.length > 0 && this.at[0] <= this.offset) {
      this.digests.set(this.at.shift()!, this.hash.copy().digest('hex'))
    }
  }
}

function transcriptOf(index: TranscriptIndex, tail: ChatMessage[], timing: ChatLoadTiming): IndexedTranscript {
  const count = index.messages.length
  return {
    path: index.path,
    messages: [...index.messages, ...tail],
    materialize: (positions) => {
      const found = new Map<number, ChatMessage>()
      for (const position of positions) if (position >= count) found.set(position, tail[position - count])
      const indexed = [...new Set(positions.filter((position) => position < count))].sort((a, b) => a - b)
      if (indexed.length > 0) readSlices(index, indexed, found, timing)
      return positions.map((position) => found.get(position)!)
    },
  }
}

/**
 * Parse the lines of `positions` (sorted) and the result lines of their calls.
 * Synchronous: a window's slices are a few MB, and the merge that asks for
 * them is synchronous.
 */
function readSlices(
  index: TranscriptIndex,
  positions: number[],
  found: Map<number, ChatMessage>,
  timing: ChatLoadTiming,
): void {
  const start = performance.now()
  let parseMs = 0
  const fd = openSync(index.path, 'r')
  const readLine = (from: number, to: number): string => {
    const buffer = Buffer.alloc(to - from)
    if (readSync(fd, buffer, 0, buffer.length, from) !== buffer.length)
      throw new StaleTranscriptIndexError(index.path, index.source)
    timing.diskBytes += buffer.length
    return buffer.toString('utf8')
  }
  try {
    for (let first = 0; first < positions.length;) {
      let last = first
      while (last + 1 < positions.length && positions[last + 1] - positions[last] <= SLICE_GAP) last++
      const from = positions[first]
      const to = positions[last]
      const text = readLine(index.starts[from], index.ends[to])
      const parseStart = performance.now()
      const parsed: ChatMessage[] = []
      let collecting = true
      const parser = new JsonlParser((message) => collecting && parsed.push(message), index.source)
      parser.feed(text)
      parser.flush()
      if (parsed.length !== to - from + 1) throw new StaleTranscriptIndexError(index.path, index.source)
      // Results after the slice still mark its calls, as in a full parse.
      const resultLines = new Map<number, number>()
      for (const call of parser.pendingToolCalls()) {
        const range = index.results[call.id]
        if (range && range[0] >= index.ends[to]) resultLines.set(range[0], range[1])
      }
      collecting = false
      for (const [lineFrom, lineTo] of [...resultLines].sort((a, b) => a[0] - b[0])) {
        parser.line(readLine(lineFrom, lineTo).replace(/\n$/, ''))
      }
      parseMs += performance.now() - parseStart
      timing.diskLines += parser.lineCount
      for (let at = first; at <= last; at++) {
        const position = positions[at]
        const meta = index.messages[position]
        const message = parsed[position - from]
        if (message.id !== meta.id && !GENERATED_ID.test(meta.id))
          throw new StaleTranscriptIndexError(index.path, index.source)
        found.set(
          position,
          message.id === meta.id && message.timestamp === meta.timestamp
            ? message
            : { ...message, id: meta.id, timestamp: meta.timestamp },
        )
      }
      first = last + 1
    }
  } finally {
    closeSync(fd)
  }
  timing.parseMs += parseMs
  timing.readMs += performance.now() - start - parseMs
}

function keyOf(path: string, source: JsonlSource): string {
  return `${source}\0${path}`
}

function indexDir(): string {
  return join(userDataDir(), 'data', 'transcript-index')
}

function indexFile(key: string): string {
  return join(indexDir(), `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)
}

interface PersistedIndex {
  v: number
  source: JsonlSource
  path: string
  state: FileState
  end: number
  guard: string
  ids: string[]
  /** One character per message: `u` user, `a` assistant. */
  roles: string
  timestamps: number[]
  starts: number[]
  ends: number[]
  pending: Array<[string, string]>
  results: Record<string, [number, number]>
  prefixes: Array<{ path: string; state: FileState }>
}

function persist(key: string, index: TranscriptIndex): void {
  const data: PersistedIndex = {
    v: VERSION,
    source: index.source,
    path: index.path,
    state: pickState(index.state),
    end: index.end,
    guard: index.guard,
    ids: index.messages.map((message) => message.id),
    roles: index.messages.map((message) => (message.role === 'user' ? 'u' : 'a')).join(''),
    timestamps: index.messages.map((message) => message.timestamp),
    starts: index.starts,
    ends: index.ends,
    pending: index.pending,
    results: index.results,
    prefixes: index.prefixes.map((proof) => ({ path: proof.path, state: pickState(proof.state) })),
  }
  const text = JSON.stringify(data)
  const file = indexFile(key)
  const next = (writes.get(key) ?? Promise.resolve())
    .then(async () => {
      await mkdir(indexDir(), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, text)
      await rename(temp, file)
    })
    .catch((err) => log.warn('could not write a transcript index', { path: index.path, err }))
  writes.set(key, next)
  void next.finally(() => {
    if (writes.get(key) === next) writes.delete(key)
  })
}

async function readPersisted(key: string, path: string, source: JsonlSource): Promise<TranscriptIndex | undefined> {
  let data: PersistedIndex
  try {
    data = JSON.parse(await readFile(indexFile(key), 'utf8')) as PersistedIndex
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('unreadable transcript index', { path, err })
    return undefined
  }
  const count = data.ids?.length
  if (
    data.v !== VERSION ||
    data.path !== path ||
    data.source !== source ||
    data.roles?.length !== count ||
    data.timestamps?.length !== count ||
    data.starts?.length !== count ||
    data.ends?.length !== count
  ) {
    log.info('transcript index is from another version or file, indexing again', { path })
    return undefined
  }
  return {
    source,
    path,
    state: data.state,
    end: data.end,
    guard: data.guard,
    messages: data.ids.map((id, at) => ({
      id,
      role: data.roles[at] === 'u' ? 'user' : 'assistant',
      timestamp: data.timestamps[at],
    })),
    starts: data.starts,
    ends: data.ends,
    pending: data.pending ?? [],
    results: data.results ?? {},
    prefixes: data.prefixes ?? [],
  }
}

function pickState(st: FileState): FileState {
  return { mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs, ino: st.ino, dev: st.dev }
}

/** Test seam: forget the in-memory copies, as a restart does. The files stay. */
export async function clearTranscriptIndexMemory(): Promise<void> {
  await Promise.all(writes.values())
  memory.clear()
}
