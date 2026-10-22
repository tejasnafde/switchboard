/**
 * Open a project on another machine, from the desktop's side
 * (`shared/project-clone.ts`). The target clones in the background; this
 * polls its status, then copies the ignored files the user picked, reading
 * each from the source machine and writing it to the target. Progress lives
 * in `useProjectCloneStore` for the dialog and the sidebar row, and a chat
 * start in that project waits on `waitForProjectClone`.
 */
import { create } from 'zustand'
import { ProjectCloneChannels } from '@shared/ipc-channels'
import {
  cloneFolderName,
  type CloneSource,
  type CloneStartResult,
  type CloneStatus,
  type IgnoredReadResult,
} from '@shared/project-clone'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('project-clone')

const POLL_MS = 1000
/** Two minutes of failed status reads ends the wait; the clone may still finish there. */
const MAX_FAILED_POLLS = 120

export type CloneProgress =
  | { phase: 'cloning'; line: string }
  | { phase: 'copying'; done: number; total: number }
  | { phase: 'done'; branch: string | null; failedFiles: string[] }
  | { phase: 'failed'; error: string }

export const cloneKey = (machineId: string, projectPath: string) => `${machineId}\u0000${projectPath}`

interface ProjectCloneState {
  clones: Record<string, CloneProgress>
  /** Bumped when a clone ends, so views drop a "no favicon" or "no repository" answer for the path. */
  readyVersion: Record<string, number>
  set: (key: string, progress: CloneProgress) => void
  markReady: (projectPath: string) => void
}

export const useProjectCloneStore = create<ProjectCloneState>((set) => ({
  clones: {},
  readyVersion: {},
  set: (key, progress) => set((s) => ({ clones: { ...s.clones, [key]: progress } })),
  markReady: (projectPath) =>
    set((s) => ({ readyVersion: { ...s.readyVersion, [projectPath]: (s.readyVersion[projectPath] ?? 0) + 1 } })),
}))

const pending = new Map<string, Promise<void>>()

export function isProjectCloning(machineId: string, projectPath: string): boolean {
  return pending.has(cloneKey(machineId, projectPath))
}

/** Resolves when a clone into this project has ended (at once when there is none); rejects when it failed. */
export async function waitForProjectClone(machineId: string, projectPath: string): Promise<void> {
  const key = cloneKey(machineId, projectPath)
  await pending.get(key)
  const progress = useProjectCloneStore.getState().clones[key]
  if (progress?.phase === 'failed') throw new Error(`The clone failed: ${progress.error}`)
}

export interface ProjectCloneApi {
  invokeOn: <T>(machineId: string, channel: string, ...args: unknown[]) => Promise<T>
  syncMachine: (machineId: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}

export const OLD_TARGET_MESSAGE =
  'Switchboard on that machine is too old to clone a project. Update it, then try again.'

/** Why a machine cannot take the project, or null when it can. */
export function cloneTargetBlock(supports: boolean | undefined): string | null {
  if (supports === undefined) return 'That machine is still connecting.'
  return supports ? null : OLD_TARGET_MESSAGE
}

/**
 * Start the clone. Resolves with the new project path once the target has
 * accepted it (the project is listed there from then on); the clone and the
 * copy carry on, reported through the store.
 */
export async function openProjectOnMachine(
  input: {
    sourceMachineId: string
    projectPath: string
    targetMachineId: string
    source: CloneSource
    files: string[]
  },
  api: ProjectCloneApi,
): Promise<CloneStartResult> {
  const { sourceMachineId, projectPath, targetMachineId, source, files } = input
  const started = await api.invokeOn<CloneStartResult>(targetMachineId, ProjectCloneChannels.CLONE, {
    url: source.url,
    remoteBranch: source.remoteBranch,
    name: cloneFolderName(projectPath),
  })
  if (!started.ok) return started
  const target = started.path
  const key = cloneKey(targetMachineId, target)
  const store = useProjectCloneStore.getState()
  store.set(key, { phase: 'cloning', line: 'Starting the clone' })
  const run = (async () => {
    const sleep = api.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    let status: CloneStatus
    let failedPolls = 0
    for (;;) {
      try {
        status = await api.invokeOn<CloneStatus>(targetMachineId, ProjectCloneChannels.STATUS, target)
        failedPolls = 0
      } catch (err) {
        // A reconnecting tunnel: keep asking, the clone runs on without us.
        log.warn('clone status read failed', err)
        if (++failedPolls >= MAX_FAILED_POLLS) throw new Error('Lost the connection to the other machine.')
        await sleep(POLL_MS)
        continue
      }
      if (status.phase !== 'cloning') break
      store.set(key, status)
      await sleep(POLL_MS)
    }
    if (status.phase !== 'done') {
      const error = status.phase === 'failed' ? status.error : 'The other machine lost track of the clone.'
      store.set(key, { phase: 'failed', error })
      return
    }
    const failedFiles: string[] = []
    for (const [index, path] of files.entries()) {
      store.set(key, { phase: 'copying', done: index, total: files.length })
      try {
        const read = await api.invokeOn<IgnoredReadResult>(
          sourceMachineId,
          ProjectCloneChannels.READ_IGNORED,
          projectPath,
          path,
        )
        const written = read.ok
          ? await api.invokeOn<{ ok: boolean; error?: string }>(
              targetMachineId,
              ProjectCloneChannels.WRITE_IGNORED,
              target,
              path,
              read.content,
            )
          : read
        if (!written.ok) {
          log.warn('copying an ignored file failed', { path, error: written.error })
          failedFiles.push(path)
        }
      } catch (err) {
        log.warn('copying an ignored file failed', { path, err })
        failedFiles.push(path)
      }
    }
    store.set(key, { phase: 'done', branch: status.branch, failedFiles })
  })()
    .catch((err: unknown) => {
      log.warn('open on machine failed', err)
      store.set(key, { phase: 'failed', error: err instanceof Error ? err.message : String(err) })
    })
    .finally(() => {
      pending.delete(key)
      store.markReady(target)
      // The row appears, or goes after a failure that removed it.
      void api.syncMachine(targetMachineId)
    })
  pending.set(key, run)
  await api.syncMachine(targetMachineId)
  return started
}
