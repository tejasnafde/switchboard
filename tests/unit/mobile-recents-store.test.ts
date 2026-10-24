/**
 * The Home recents store: an unpaired machine leaves nothing on disk, a
 * disconnect drops its live reply, and an older reply never lands over a newer one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const clients = new Map<string, unknown>()
vi.mock('../../apps/mobile/node_modules/@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}))
vi.mock('../../apps/mobile/src/stores/connections', () => ({ getClient: (id: string) => clients.get(id) }))

import { useRecentsStore } from '../../apps/mobile/src/stores/recents'
import type { Project } from '../../src/shared/types'

function projects(id: string): Project[] {
  return [
    {
      path: '/a',
      name: 'a',
      sessions: [{ id, source: 'claude-code', title: id, startedAt: 1, messageCount: 1, filePath: '' }],
    },
  ]
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  clients.clear()
  useRecentsStore.setState({ sessions: {}, live: {} })
})

describe('recents store', () => {
  it('drops an older reply that lands after a newer one', async () => {
    const first = deferred<Project[]>()
    const second = deferred<Project[]>()
    const calls = [first.promise, second.promise]
    clients.set('mac', { getProjects: () => calls.shift(), listLiveSessions: async () => [] })
    const a = useRecentsStore.getState().refresh('mac')
    const b = useRecentsStore.getState().refresh('mac')
    second.resolve(projects('new'))
    await b
    first.resolve(projects('old'))
    await a
    expect(useRecentsStore.getState().sessions.mac.map((s) => s.id)).toEqual(['new'])
  })

  it('drops the live reply on disconnect, and everything on unpair', async () => {
    clients.set('mac', {
      getProjects: async () => projects('t'),
      listLiveSessions: async () => [{ threadId: 't', status: 'running' }],
    })
    await useRecentsStore.getState().refresh('mac')
    expect(useRecentsStore.getState().live.mac?.statuses).toEqual({ t: 'running' })
    useRecentsStore.getState().dropLive('mac')
    expect(useRecentsStore.getState().live.mac).toBeUndefined()
    useRecentsStore.getState().forget('mac')
    expect(useRecentsStore.getState().sessions.mac).toBeUndefined()
    const written = useRecentsStore.persist.getOptions().partialize?.(useRecentsStore.getState())
    expect(written).toEqual({ sessions: {} })
  })
})
