import { describe, expect, it, vi } from 'vitest'
import { openPillSourceChat, type PillChatOpenerDeps } from '../../src/renderer/services/pill-chat-opener'
import { PILL_OPEN_SUPERSEDED } from '../../src/renderer/services/pill-message-open'

const meta = { projectPath: '/repo', agentType: 'claude-code', title: 'Source chat' }

function deps(overrides: Partial<PillChatOpenerDeps> = {}) {
  let ticket = 1
  let focused: string | null = 'host'
  const value = {
    sessions: () => [{ id: 'host', machineId: 'vm', projectPath: '/repo', title: 'Host' }],
    bindRoute: vi.fn(),
    unbindRoute: vi.fn(),
    probeMeta: vi.fn(async () => meta),
    openSession: vi.fn(async (session: { id: string }) => {
      ticket++
      focused = session.id
    }),
    focusedId: () => focused,
    latestOpenTicket: () => ticket,
    ...overrides,
  }
  return {
    value,
    navigate: (id: string) => {
      ticket++
      focused = id
    },
  }
}

describe('openPillSourceChat', () => {
  it('opens a chat that is not loaded on the host chat machine', async () => {
    const d = deps()
    const result = await openPillSourceChat('src', 'host', () => true, d.value)
    expect(d.value.bindRoute).toHaveBeenCalledWith('src', 'vm')
    expect(d.value.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'src', title: 'Source chat' }),
      '/repo',
      'vm',
    )
    expect(d.value.unbindRoute).not.toHaveBeenCalled()
    expect(result).toBe('src')
  })

  it('reports a gone chat and drops its route when the probe rejects', async () => {
    const d = deps({ probeMeta: vi.fn(async () => Promise.reject(new Error('socket closed'))) })
    await expect(openPillSourceChat('src', 'host', () => true, d.value)).resolves.toBeNull()
    expect(d.value.unbindRoute).toHaveBeenCalledWith('src')
    expect(d.value.openSession).not.toHaveBeenCalled()
  })

  it('reports a gone chat and drops its route when the probe has no metadata', async () => {
    const d = deps({ probeMeta: vi.fn(async () => null) })
    await expect(openPillSourceChat('src', 'host', () => true, d.value)).resolves.toBeNull()
    expect(d.value.unbindRoute).toHaveBeenCalledWith('src')
  })

  it('does not switch chat when the user opened another chat during the probe', async () => {
    const d = deps()
    d.value.probeMeta = vi.fn(async () => {
      d.navigate('elsewhere')
      return meta
    })
    await expect(openPillSourceChat('src', 'host', () => true, d.value)).resolves.toBe(PILL_OPEN_SUPERSEDED)
    expect(d.value.openSession).not.toHaveBeenCalled()
    expect(d.value.unbindRoute).toHaveBeenCalledWith('src')
  })

  it('does not switch chat when a newer chip open started during the probe', async () => {
    let current = true
    const d = deps()
    d.value.probeMeta = vi.fn(async () => {
      current = false
      return meta
    })
    await expect(openPillSourceChat('src', 'host', () => current, d.value)).resolves.toBe(PILL_OPEN_SUPERSEDED)
    expect(d.value.openSession).not.toHaveBeenCalled()
  })
})
