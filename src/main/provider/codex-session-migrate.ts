import { isAbsolute, join, relative, resolve } from 'node:path'
import { scanCodexSessionCopies } from '../projects/session-scanner'
import {
  synchronizeCompatibleTranscript,
  type TranscriptSyncResult,
} from './transcript-compatibility'

export type CodexProfileSwitchPreparationResult = TranscriptSyncResult
  | { ok: false; reason: 'source-missing'; detail: string; sourcePath: string; targetPath: string }

export async function prepareCodexProfileSwitch(options: {
  sessionId: string
  fromDir: string
  toDir: string
}): Promise<CodexProfileSwitchPreparationResult> {
  const sourceRoot = resolve(options.fromDir)
  const targetRoot = resolve(options.toDir)
  const [sourceSessions, targetSessions] = await Promise.all([
    scanCodexSessionCopies(new Set([options.sessionId]), [sourceRoot]),
    scanCodexSessionCopies(new Set([options.sessionId]), [targetRoot]),
  ])
  const sourcePaths = Array.from(new Set(sourceSessions.map((session) => resolve(session.filePath))))
  const targetPaths = Array.from(new Set(targetSessions.map((session) => resolve(session.filePath))))
  if (sourcePaths.length !== 1) {
    const targetPath = targetPaths[0] ?? join(targetRoot, 'sessions', `${options.sessionId}.jsonl`)
    return {
      ok: false,
      reason: sourcePaths.length === 0 ? 'source-missing' : 'context-conflict',
      detail: sourcePaths.length === 0
        ? 'The active Codex home has no rollout for this native session'
        : 'The active Codex home has multiple rollouts for this native session',
      sourcePath: sourcePaths[0] ?? join(sourceRoot, 'sessions', `${options.sessionId}.jsonl`),
      targetPath,
    }
  }
  if (targetPaths.length > 1) {
    return {
      ok: false,
      reason: 'context-conflict',
      detail: 'The target Codex home has multiple rollouts for this native session',
      sourcePath: sourcePaths[0],
      targetPath: targetPaths[0],
    }
  }
  const targetPath = targetPaths[0] ?? targetPathFor(sourcePaths[0], [sourceRoot], targetRoot)
  return synchronizeCompatibleTranscript(sourcePaths[0], targetPath)
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
