import { describe, expect, it } from 'vitest'
import { ProjectCloneChannels } from '../../src/shared/ipc-channels'
import type { CloneSource, CloneStatus } from '../../src/shared/project-clone'
import {
  OLD_TARGET_FOLDER_MESSAGE,
  OLD_TARGET_MESSAGE,
  cloneKey,
  cloneTargetBlock,
  isProjectCloning,
  openProjectOnMachine,
  useProjectCloneStore,
  waitForProjectClone,
} from '../../src/renderer/services/project-clone'

const source: CloneSource = {
  remoteName: 'fork',
  url: 'git@example.com:me/app.git',
  branch: 'feat',
  remoteBranch: 'feat',
  ignored: [
    { path: '.env', size: 4 },
    { path: 'gone.txt', size: 1 },
  ],
  skippedIgnored: 0,
}

function fakeApi(statuses: CloneStatus[]) {
  const calls: Array<[string, string, ...unknown[]]> = []
  const synced: string[] = []
  return {
    calls,
    synced,
    api: {
      sleep: async () => {},
      syncMachine: async (id: string) => {
        synced.push(id)
      },
      invokeOn: async <T>(machineId: string, channel: string, ...args: unknown[]): Promise<T> => {
        calls.push([machineId, channel, ...args])
        if (channel === ProjectCloneChannels.CLONE) return { ok: true, path: '/home/u/projects/app' } as T
        if (channel === ProjectCloneChannels.STATUS) return statuses.shift() as T
        if (channel === ProjectCloneChannels.READ_IGNORED)
          return (args[1] === '.env' ? { ok: true, content: 'A=1\n' } : { ok: false, error: 'gone' }) as T
        return { ok: true } as T
      },
    },
  }
}

describe('openProjectOnMachine', () => {
  it('waits for the clone, copies the picked files source to target, and clears cached misses', async () => {
    const { api, calls, synced } = fakeApi([
      { phase: 'cloning', line: 'Receiving objects: 50%' },
      { phase: 'done', branch: 'feat' },
    ])
    const before = useProjectCloneStore.getState().readyVersion['/home/u/projects/app'] ?? 0
    const started = await openProjectOnMachine(
      {
        sourceMachineId: 'local',
        projectPath: '/Users/me/app',
        targetMachineId: 'vm',
        source,
        files: ['.env', 'gone.txt'],
      },
      api,
    )
    expect(started).toEqual({ ok: true, path: '/home/u/projects/app' })
    expect(isProjectCloning('vm', '/home/u/projects/app')).toBe(true)
    await waitForProjectClone('vm', '/home/u/projects/app')
    expect(isProjectCloning('vm', '/home/u/projects/app')).toBe(false)

    expect(calls[0]).toEqual(['vm', ProjectCloneChannels.CLONE, { url: source.url, remoteBranch: 'feat', name: 'app' }])
    expect(calls).toContainEqual(['local', ProjectCloneChannels.READ_IGNORED, '/Users/me/app', '.env'])
    expect(calls).toContainEqual(['vm', ProjectCloneChannels.WRITE_IGNORED, '/home/u/projects/app', '.env', 'A=1\n'])
    expect(calls.some((c) => c[1] === ProjectCloneChannels.WRITE_IGNORED && c[3] === 'gone.txt')).toBe(false)
    expect(useProjectCloneStore.getState().clones[cloneKey('vm', '/home/u/projects/app')]).toEqual({
      phase: 'done',
      branch: 'feat',
      failedFiles: ['gone.txt'],
    })
    expect(useProjectCloneStore.getState().readyVersion['/home/u/projects/app']).toBe(before + 1)
    expect(synced).toEqual(['vm', 'vm'])
  })

  it('reports a failed clone and copies nothing', async () => {
    const { api, calls } = fakeApi([{ phase: 'failed', error: 'Permission denied (publickey).' }])
    await openProjectOnMachine(
      { sourceMachineId: 'local', projectPath: '/Users/me/app', targetMachineId: 'vm2', source, files: ['.env'] },
      api,
    )
    await expect(waitForProjectClone('vm2', '/home/u/projects/app')).rejects.toThrow('Permission denied')
    expect(useProjectCloneStore.getState().clones[cloneKey('vm2', '/home/u/projects/app')]).toEqual({
      phase: 'failed',
      error: 'Permission denied (publickey).',
    })
    expect(calls.some((c) => c[1] === ProjectCloneChannels.READ_IGNORED)).toBe(false)
  })

  it('refuses a target without the capability', () => {
    expect(cloneTargetBlock(false)).toBe(OLD_TARGET_MESSAGE)
    expect(cloneTargetBlock(undefined)).not.toBeNull()
    expect(cloneTargetBlock(true)).toBeNull()
  })

  it('refuses a chosen folder on a target that would drop it, but not the default folder', () => {
    expect(cloneTargetBlock(true, { custom: true, supported: false })).toBe(OLD_TARGET_FOLDER_MESSAGE)
    expect(cloneTargetBlock(true, { custom: true, supported: undefined })).toBe(OLD_TARGET_FOLDER_MESSAGE)
    expect(cloneTargetBlock(true, { custom: false, supported: false })).toBeNull()
    expect(cloneTargetBlock(true, { custom: true, supported: true })).toBeNull()
    expect(cloneTargetBlock(false, { custom: false, supported: false })).toBe(OLD_TARGET_MESSAGE)
  })

  it('sends a chosen folder as path, and leaves path out for the default', async () => {
    const custom = fakeApi([{ phase: 'done', branch: 'feat' }])
    await openProjectOnMachine(
      {
        sourceMachineId: 'local',
        projectPath: '/Users/me/app',
        targetMachineId: 'vm3',
        source,
        files: [],
        targetFolder: '~/code/app',
      },
      custom.api,
    )
    await waitForProjectClone('vm3', '/home/u/projects/app')
    expect(custom.calls[0][2]).toEqual({ url: source.url, remoteBranch: 'feat', name: 'app', path: '~/code/app' })
  })
})
