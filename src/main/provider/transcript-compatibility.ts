import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

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

async function readJsonl(path: string): Promise<ReadResult> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    return { ok: false, reason: fsError(error) }
  }

  try {
    const before = await handle.stat()
    const hash = createHash('sha256')
    const decoder = new StringDecoder('utf8')
    const records: string[] = []
    let carry = ''

    for await (const chunk of handle.createReadStream({ autoClose: false })) {
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
        } catch {
          return { ok: false, reason: `Invalid JSON at record ${recordNumber}` }
        }
        records.push(record)
        newline = carry.indexOf('\n')
      }
    }
    carry += decoder.end()
    if (carry.length > 0) {
      return { ok: false, reason: 'Incomplete trailing record' }
    }

    const after = await handle.stat()
    if (!sameFileState(before, after)) {
      return { ok: false, reason: 'Transcript changed while it was being read' }
    }
    return {
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
  } finally {
    await handle.close()
  }
}

export async function compareJsonlTranscripts(
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

export async function synchronizeCompatibleTranscript(
  sourcePath: string,
  targetPath: string,
  options: TranscriptSyncOptions = {},
): Promise<TranscriptSyncResult> {
  try {
    const initial = await compareJsonlTranscripts(sourcePath, targetPath)
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
      await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL)
      const copied = await compareJsonlTranscripts(sourcePath, temporaryPath)
      if (copied.kind !== 'equal') {
        return {
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
    return {
      ok: false,
      reason: 'io-error',
      detail: error instanceof Error ? error.message : String(error),
      sourcePath,
      targetPath,
    }
  }
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

function sameFileState(
  before: { size: number; mtimeMs: number; ino: bigint | number; dev: bigint | number },
  after: { size: number; mtimeMs: number; ino: bigint | number; dev: bigint | number },
): boolean {
  return before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ino === after.ino &&
    before.dev === after.dev
}

function fsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return code || (error instanceof Error ? error.message : String(error))
}
