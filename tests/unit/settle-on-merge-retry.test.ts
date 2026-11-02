/**
 * Settle on merge: a link change to merged is seen once, so a settle that
 * throws is retried after a delay, re-checking the rule at each try, and the
 * retries and later settles stop on detach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  settledAt: null as number | null,
  failures: 0,
  readFailures: 0,
  writes: 0,
}))

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../src/main/runtime', () => ({ userDataDir: () => '/nonexistent', getSafeStorage: () => null }))
vi.mock('../../src/main/db/database', () => ({
  getProjects: () => [],
  listHiddenPullRequestRepos: () => [],
  setPullRequestLinkState: () => ['chat-1'],
  getConversationByThreadId: (id: string) => {
    if (db.readFailures > 0) {
      db.readFailures--
      throw new Error('SQLITE_BUSY')
    }
    return id === 'chat-1' ? { id, project_path: '/p', worktree_path: null, settled_at: db.settledAt } : null
  },
  setConversationSettled: (_id: string, at: number | null) => {
    db.writes++
    if (db.failures > 0) {
      db.failures--
      throw new Error('SQLITE_BUSY')
    }
    db.settledAt = at
    return true
  },
  getConversationTitle: () => 'Fix the thing',
  getConversationSnooze: () => null,
  resolveRootThreadId: (id: string) => id,
}))
vi.mock('../../src/main/pull-requests/service', () => ({
  PullRequestService: class {
    merge() {
      return Promise.resolve({ ok: true, data: {} })
    }
  },
}))

import { attachPullRequestAutoLink, registerPullRequestHandlers } from '../../src/main/ipc/pull-requests'
import { AppChannels, PullRequestWriteChannels } from '../../src/shared/ipc-channels'
import { SETTLE_RETRY_DELAYS_MS } from '../../src/main/pull-requests/settle-on-merge'

const ref = { host: 'github', owner: 'o', name: 'r', number: 7 }

function setup(activity = { busy: false, needsUser: false }) {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  const emit = vi.fn()
  const host = { handle: (channel: string, fn: unknown) => void map.set(channel, fn as never), on: vi.fn(), emit }
  registerPullRequestHandlers(host as never)
  const detach = attachPullRequestAutoLink({ subscribe: () => () => {} } as never, host as never, {
    busy: () => activity.busy,
    needsUser: () => activity.needsUser,
  })
  const merge = () => map.get(PullRequestWriteChannels.MERGE)!(ref, {})
  const settled = () => emit.mock.calls.filter(([channel]) => channel === AppChannels.CONVERSATION_SETTLED)
  return { merge, settled, detach, activity }
}

beforeEach(() => {
  vi.useFakeTimers()
  db.settledAt = null
  db.failures = 0
  db.readFailures = 0
  db.writes = 0
})
afterEach(() => vi.useRealTimers())

describe('settle on merge retry', () => {
  it('settles on a later try when the first settle throws', async () => {
    db.failures = 1
    const { merge, settled, detach } = setup()
    await merge()
    expect(settled()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTLE_RETRY_DELAYS_MS[0])
    expect(settled()).toHaveLength(1)
    expect(settled()[0][1]).toMatchObject({ conversationId: 'chat-1', prNumber: 7 })
    detach()
  })

  it('retries when reading the chat throws', async () => {
    db.readFailures = 1
    const { merge, settled, detach } = setup()
    await merge()
    expect(settled()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTLE_RETRY_DELAYS_MS[0])
    expect(settled()).toHaveLength(1)
    detach()
  })

  it('gives up after the last delay', async () => {
    db.failures = 99
    const { merge, settled, detach } = setup()
    await merge()
    for (const delay of SETTLE_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(db.writes).toBe(SETTLE_RETRY_DELAYS_MS.length + 1)
    expect(settled()).toHaveLength(0)
    detach()
  })

  it('does not retry once the chat starts a turn', async () => {
    db.failures = 1
    const { merge, settled, detach, activity } = setup()
    await merge()
    activity.busy = true
    await vi.advanceTimersByTimeAsync(SETTLE_RETRY_DELAYS_MS[0])
    expect(db.writes).toBe(1)
    expect(settled()).toHaveLength(0)
    detach()
  })

  it('never settles a chat that is busy when the PR merges', async () => {
    const { merge, settled, detach, activity } = setup()
    activity.busy = true
    await merge()
    activity.busy = false
    await vi.advanceTimersByTimeAsync(600_000)
    expect(db.writes).toBe(0)
    expect(settled()).toHaveLength(0)
    detach()
  })

  it('drops pending retries on detach', async () => {
    db.failures = 1
    const { merge, settled, detach } = setup()
    await merge()
    detach()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(db.writes).toBe(1)
    expect(settled()).toHaveLength(0)
  })

  it('does not settle once detached', async () => {
    const { merge, settled, detach } = setup()
    detach()
    await merge()
    expect(db.writes).toBe(0)
    expect(settled()).toHaveLength(0)
  })
})
