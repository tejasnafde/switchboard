import {
  copyFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { scanCodexSessionCopies } from '../projects/session-scanner'

export type CodexSessionMigrateResult =
  | { ok: true; copied: boolean; sourcePath: string; targetPath: string }
  | { ok: false; reason: 'source-missing' }
  | { ok: false; reason: 'io-error'; detail: string }

export interface CodexSessionMigrateOptions {
  sessionId: string
  toDir: string
  candidates: string[]
}

export async function ensureCodexSessionResumable(
  options: CodexSessionMigrateOptions,
): Promise<CodexSessionMigrateResult> {
  try {
    const dirs = Array.from(new Set(
      [options.toDir, ...options.candidates].map((dir) => resolve(dir)),
    ))
    const sessions = await scanCodexSessionCopies(new Set([options.sessionId]), dirs)
    const copies = sessions.map((session) => {
      const stats = statSync(session.filePath)
      return {
        path: resolve(session.filePath),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      }
    }).sort(compareCopies)

    const freshest = copies[0]
    if (!freshest) return { ok: false, reason: 'source-missing' }

    const targetRoot = resolve(options.toDir)
    const targetCopies = copies.filter((copy) => isWithin(targetRoot, copy.path))
    const target = targetCopies[0]
    if (target && isAtLeastAsComplete(target, freshest)) {
      return {
        ok: true,
        copied: false,
        sourcePath: target.path,
        targetPath: target.path,
      }
    }

    const targetPath = target?.path ?? targetPathFor(freshest.path, dirs, targetRoot)
    atomicCopy(freshest.path, targetPath)
    return {
      ok: true,
      copied: true,
      sourcePath: freshest.path,
      targetPath,
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'io-error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

interface SessionCopy {
  path: string
  size: number
  mtimeMs: number
}

function compareCopies(a: SessionCopy, b: SessionCopy): number {
  return b.size - a.size || b.mtimeMs - a.mtimeMs
}

function isAtLeastAsComplete(candidate: SessionCopy, reference: SessionCopy): boolean {
  return candidate.size > reference.size ||
    (candidate.size === reference.size && candidate.mtimeMs >= reference.mtimeMs)
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function targetPathFor(sourcePath: string, candidateDirs: string[], targetRoot: string): string {
  const sourceRoot = candidateDirs
    .filter((candidate) => isWithin(candidate, sourcePath))
    .sort((a, b) => b.length - a.length)[0]
  if (!sourceRoot) throw new Error('Codex rollout is outside every candidate CODEX_HOME')

  const rel = relative(sourceRoot, sourcePath)
  if (rel !== 'sessions' && !rel.startsWith(`sessions${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Codex rollout is outside the sessions directory')
  }
  const target = resolve(targetRoot, rel)
  if (!isWithin(targetRoot, target)) throw new Error('Codex rollout target escaped CODEX_HOME')
  return target
}

function atomicCopy(sourcePath: string, targetPath: string): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.switchboard-${process.pid}-${Math.random().toString(36).slice(2)}`,
  )
  try {
    copyFileSync(sourcePath, temporaryPath)
    renameSync(temporaryPath, targetPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}
