import { perfSpan } from '../perf'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createMainLogger } from '../logger'

const log = createMainLogger('provider:transcript')

export interface TranscriptSnapshot {
  path: string
  size: number
  mtimeMs: number
  ino: number
  dev: number
  digest: string
  recordCount: number
}

type CompatibleKind = 'target-missing' | 'equal' | 'target-prefix' | 'source-prefix'

export type TranscriptCompatibility =
  | {
      kind: CompatibleKind
      source: TranscriptSnapshot
      target: TranscriptSnapshot | null
    }
  | {
      kind: 'divergent'
      source: TranscriptSnapshot
      target: TranscriptSnapshot
      firstDifferentRecord: number
    }
  | {
      kind: 'unreadable'
      side: 'source' | 'target'
      reason: string
      source: TranscriptSnapshot | null
      target: TranscriptSnapshot | null
    }

export type TranscriptSyncResult =
  | {
      ok: true
      copied: boolean
      compatibility: CompatibleKind
      sourcePath: string
      targetPath: string
    }
  | {
      ok: false
      reason: 'context-conflict' | 'concurrent-modification' | 'io-error'
      detail: string
      sourcePath: string
      targetPath: string
    }

export interface TranscriptSyncOptions {
  beforeReplace?: () => void | Promise<void>
}

type ReadResult =
  | { ok: true; snapshot: TranscriptSnapshot; records: string[] }
  | { ok: false; reason: string }

interface ValidatedEvidence {
  state: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
  result: Extract<ReadResult, { ok: true }>
}

// Retain record digests, not large tool results or image bodies.
const evidenceCache = new Map<string, ValidatedEvidence>()
const MAX_EVIDENCE_RECORDS = 100_000
let evidenceRecords = 0

function cacheEvidence(path: string, entry: ValidatedEvidence): void {
  const previous = evidenceCache.get(path)
  evidenceRecords -= previous?.result.records.length ?? 0
  evidenceCache.delete(path)
  evidenceCache.set(path, entry)
  evidenceRecords += entry.result.records.length
  while (evidenceCache.size > 24 || evidenceRecords > MAX_EVIDENCE_RECORDS) {
    const oldest = evidenceCache.entries().next().value
    if (!oldest) break
    evidenceRecords -= oldest[1].result.records.length
    evidenceCache.delete(oldest[0])
  }
}

const CHANGED_WHILE_READ = 'Transcript changed while it was being read'

async function readJsonl(path: string): Promise<ReadResult> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('transcript open failed', { error })
    return { ok: false, reason: fsError(error) }
  }

  try {
    let before = await handle.stat()
    const cached = evidenceCache.get(path)
    // Metadata alone never proves the bytes are the same, so a hit re-hashes
    // the file. That still skips the per-record parse, which is most of the cost.
    if (cached && sameFileState(cached.state, before) && await fileDigest(handle) === cached.result.snapshot.digest) {
      // A read stream is not a snapshot: a write during the hash shows up here.
      const after = await handle.stat()
      if (sameFileState(before, after)) {
        evidenceCache.delete(path)
        evidenceCache.set(path, cached)
        return cached.result
      }
      before = after
    }
    const hash = createHash('sha256')
    const decoder = new StringDecoder('utf8')
    const records: string[] = []
    let carry = ''

    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      const bytes = chunk as Buffer
      hash.update(bytes)
      carry += decoder.write(bytes)
      let newline = carry.indexOf('\n')
      while (newline !== -1) {
        const raw = carry.slice(0, newline)
        carry = carry.slice(newline + 1)
        const record = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        const recordNumber = records.length + 1
        try {
          JSON.parse(record)
        } catch (error) {
          log.warn('invalid transcript record', { recordNumber, error: error instanceof Error ? error.name : 'unknown' })
          return { ok: false, reason: `Invalid JSON at record ${recordNumber}` }
        }
        records.push(createHash('sha256').update(record).digest('hex'))
        newline = carry.indexOf('\n')
      }
    }
    carry += decoder.end()
    if (carry.length > 0) {
      return { ok: false, reason: 'Incomplete trailing record' }
    }

    const after = await handle.stat()
    if (!sameFileState(before, after)) {
      return { ok: false, reason: CHANGED_WHILE_READ }
    }
    const result: Extract<ReadResult, { ok: true }> = {
      ok: true,
      snapshot: {
        path,
        size: after.size,
        mtimeMs: after.mtimeMs,
        ino: Number(after.ino),
        dev: Number(after.dev),
        digest: hash.digest('hex'),
        recordCount: records.length,
      },
      records,
    }
    cacheEvidence(path, { state: before, result })
    return result
  } finally {
    await handle.close()
  }
}

export async function compareJsonlTranscripts(
  sourcePath: string,
  targetPath: string,
): Promise<TranscriptCompatibility> {
  const span = perfSpan('transcript.compare')
  let result: TranscriptCompatibility | undefined
  try {
    result = await compareTranscripts(sourcePath, targetPath)
    return result
  } finally {
    span.end({ kind: result?.kind ?? 'error', sourceBytes: result?.source?.size, targetBytes: result?.target?.size })
  }
}

async function compareTranscripts(
  sourcePath: string,
  targetPath: string,
): Promise<TranscriptCompatibility> {
  const source = await readJsonl(sourcePath)
  if (!source.ok) {
    return { kind: 'unreadable', side: 'source', reason: source.reason, source: null, target: null }
  }

  const target = await readJsonl(targetPath)
  if (!target.ok) {
    if (target.reason === 'ENOENT') {
      return { kind: 'target-missing', source: source.snapshot, target: null }
    }
    return {
      kind: 'unreadable',
      side: 'target',
      reason: target.reason,
      source: source.snapshot,
      target: null,
    }
  }

  const shared = Math.min(source.records.length, target.records.length)
  for (let index = 0; index < shared; index++) {
    if (source.records[index] !== target.records[index]) {
      return {
        kind: 'divergent',
        source: source.snapshot,
        target: target.snapshot,
        firstDifferentRecord: index,
      }
    }
  }
  if (source.records.length === target.records.length) {
    return { kind: 'equal', source: source.snapshot, target: target.snapshot }
  }
  if (target.records.length < source.records.length) {
    return { kind: 'target-prefix', source: source.snapshot, target: target.snapshot }
  }
  return { kind: 'source-prefix', source: source.snapshot, target: target.snapshot }
}

// The source CLI is stopped just before a profile switch, but it keeps
// writing for a moment (a stopped background task appends its notification
// about two seconds later). A change on the source side alone is that tail,
// so compare again once it lands. A change on the target side still aborts.
const SOURCE_SETTLE_ATTEMPTS = 3
const SOURCE_SETTLE_DELAY_MS = 750
const SOURCE_CHANGED = Symbol('source-changed')

type TargetBaseline = { digest?: string | null }

type SyncAttempt = TranscriptSyncResult & { [SOURCE_CHANGED]?: true }

export async function synchronizeCompatibleTranscript(
  sourcePath: string,
  targetPath: string,
  options: TranscriptSyncOptions & { settle?: () => Promise<void> } = {},
): Promise<TranscriptSyncResult> {
  // The target seen by the first attempt. A retry that finds any other target
  // (changed, created or deleted) aborts, so a retry never overwrites it.
  const baseline: TargetBaseline = {}
  for (let attempt = 1; ; attempt++) {
    const { [SOURCE_CHANGED]: sourceChanged, ...result } = await synchronizeOnce(sourcePath, targetPath, options, baseline)
    if (!sourceChanged || attempt >= SOURCE_SETTLE_ATTEMPTS) return result
    await (options.settle?.() ?? new Promise((resolve) => setTimeout(resolve, SOURCE_SETTLE_DELAY_MS)))
  }
}

async function synchronizeOnce(
  sourcePath: string,
  targetPath: string,
  options: TranscriptSyncOptions,
  baseline: TargetBaseline,
): Promise<SyncAttempt> {
  try {
    const initial = await compareJsonlTranscripts(sourcePath, targetPath)
    if (initial.kind === 'unreadable' && initial.side === 'source' && initial.reason === CHANGED_WHILE_READ) {
      return { ...conflict(sourcePath, targetPath, initial.kind), [SOURCE_CHANGED]: true }
    }
    if (!(initial.kind === 'unreadable' && initial.side === 'target')) {
      const target = initial.target?.digest ?? null
      if (baseline.digest === undefined) baseline.digest = target
      else if (baseline.digest !== target) {
        return {
          ok: false,
          reason: 'concurrent-modification',
          detail: 'Target transcript changed while the switch waited for the source to settle',
          sourcePath,
          targetPath,
        }
      }
    }
    if (initial.kind === 'divergent' || initial.kind === 'unreadable') {
      return conflict(sourcePath, targetPath, initial.kind)
    }
    if (initial.kind === 'equal' || initial.kind === 'source-prefix') {
      return {
        ok: true,
        copied: false,
        compatibility: initial.kind,
        sourcePath,
        targetPath,
      }
    }

    await options.beforeReplace?.()
    const confirmed = await compareJsonlTranscripts(sourcePath, targetPath)
    if (!sameEvidence(initial, confirmed)) {
      return {
        ...(onlySourceChanged(initial, confirmed) ? { [SOURCE_CHANGED]: true as const } : {}),
        ok: false,
        reason: 'concurrent-modification',
        detail: 'Source or target transcript changed after compatibility was checked',
        sourcePath,
        targetPath,
      }
    }

    await mkdir(dirname(targetPath), { recursive: true })
    const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.switchboard-${randomUUID()}`)
    try {
      const copySpan = perfSpan('transcript.copy', { sourceBytes: confirmed.source?.size })
      try {
        await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL)
      } finally {
        copySpan.end()
      }
      const copied = await compareJsonlTranscripts(sourcePath, temporaryPath)
      if (copied.kind !== 'equal') {
        return {
          [SOURCE_CHANGED]: true,
          ok: false,
          reason: 'concurrent-modification',
          detail: 'Source transcript changed while its replacement was copied',
          sourcePath,
          targetPath,
        }
      }

      const beforeRename = await compareJsonlTranscripts(sourcePath, targetPath)
      if (!sameEvidence(confirmed, beforeRename)) {
        return {
          ...(onlySourceChanged(confirmed, beforeRename) ? { [SOURCE_CHANGED]: true as const } : {}),
          ok: false,
          reason: 'concurrent-modification',
          detail: 'Source or target transcript changed before replacement',
          sourcePath,
          targetPath,
        }
      }

      await rename(temporaryPath, targetPath)
      const installed = await compareJsonlTranscripts(sourcePath, targetPath)
      if (installed.kind !== 'equal') {
        return conflict(sourcePath, targetPath, 'installed transcript did not match its source')
      }
      return {
        ok: true,
        copied: true,
        compatibility: initial.kind,
        sourcePath,
        targetPath,
      }
    } finally {
      await rm(temporaryPath, { force: true })
    }
  } catch (error) {
    log.warn('transcript synchronization failed', { error })
    return {
      ok: false,
      reason: 'io-error',
      detail: error instanceof Error ? error.message : String(error),
      sourcePath,
      targetPath,
    }
  }
}

function onlySourceChanged(a: TranscriptCompatibility, b: TranscriptCompatibility): boolean {
  return a.source?.digest !== b.source?.digest && a.target?.digest === b.target?.digest
}

function sameEvidence(a: TranscriptCompatibility, b: TranscriptCompatibility): boolean {
  return a.kind === b.kind &&
    a.source?.digest === b.source?.digest &&
    a.target?.digest === b.target?.digest
}

function conflict(sourcePath: string, targetPath: string, detail: string): TranscriptSyncResult {
  return {
    ok: false,
    reason: 'context-conflict',
    detail,
    sourcePath,
    targetPath,
  }
}

async function fileDigest(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function sameFileState(
  before: { size: number; mtimeMs: number; ctimeMs: number; ino: bigint | number; dev: bigint | number },
  after: { size: number; mtimeMs: number; ctimeMs: number; ino: bigint | number; dev: bigint | number },
): boolean {
  return before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.ino === after.ino &&
    before.dev === after.dev
}

function fsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return code || (error instanceof Error ? error.message : String(error))
}
