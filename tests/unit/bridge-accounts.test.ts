/**
 * The bridge's account choice: the pure ranking rule (`pickBridgeAccount`)
 * and the reader that turns a usage probe into the view `list_agents`
 * answers and `start_chat` picks from.
 */
import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_ACCOUNT_BUSY_PERCENT, pickBridgeAccount, type BridgeAccountRoom } from '../../src/shared/bridge'
import type { ProviderUsage, UsageWindow } from '../../src/shared/provider-usage'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))

import { bridgeAccountById, chooseBridgeAccount, readBridgeAccounts } from '../../src/main/bridge/accounts'

const room = (id: string, session: number | null, weekly: number | null): BridgeAccountRoom => ({
  account_id: id,
  session_percent: session,
  weekly_percent: weekly,
})

describe('pickBridgeAccount', () => {
  it('answers null for no account', () => {
    expect(pickBridgeAccount([])).toBeNull()
  })

  it('prefers a five-hour window under the busy percent, then the emptiest weekly window', () => {
    const picked = pickBridgeAccount([room('a', 95, 5), room('b', 40, 60), room('c', 20, 30)])
    expect(picked).toBe('c')
  })

  it('ranks every account together when each five-hour window is busy', () => {
    expect(pickBridgeAccount([room('a', 99, 70), room('b', 95, 20)])).toBe('b')
    expect(BRIDGE_ACCOUNT_BUSY_PERCENT).toBe(90)
  })

  it('treats the busy percent itself as no room', () => {
    expect(pickBridgeAccount([room('a', 90, 1), room('b', 89, 80)])).toBe('b')
  })

  it('ranks an unread weekly window behind one it could read', () => {
    expect(pickBridgeAccount([room('a', 10, null), room('b', 10, 99)])).toBe('b')
  })

  it('never counts an unread five-hour window as room, so a signed-out account does not win', () => {
    expect(pickBridgeAccount([room('a', 95, 10), room('b', null, 50)])).toBe('a')
    expect(pickBridgeAccount([room('a', 95, 90), room('b', null, 50)])).toBe('b')
  })

  it('ranks every account together when no five-hour window could be read', () => {
    expect(pickBridgeAccount([room('a', null, 70), room('b', null, 20)])).toBe('b')
  })

  it('keeps the first of the list on equal readings, so the answer never flaps', () => {
    expect(pickBridgeAccount([room('a', 10, 20), room('b', 10, 20)])).toBe('a')
    expect(pickBridgeAccount([room('b', 10, 20), room('a', 10, 20)])).toBe('b')
  })
})

function window_(kind: UsageWindow['kind'], used: number | null, resetsAtMs: number | null): UsageWindow {
  return {
    id: `${kind}-${used}`,
    label: kind,
    kind,
    usedPercent: used,
    resetsAtMs,
    windowMinutes: null,
    severity: 'ok',
  }
}

function usage(partial: Partial<ProviderUsage>): ProviderUsage {
  return {
    instanceId: 'x',
    agentType: 'claude-code',
    status: 'ok',
    plan: null,
    account: null,
    windows: [],
    overage: [],
    fetchedAtMs: 0,
    ...partial,
  }
}

describe('readBridgeAccounts', () => {
  const accounts = [
    { id: 'work', name: 'Work' },
    { id: 'home', name: 'Home' },
  ]

  it('reports both windows as percent and ISO reset, and never a credential', async () => {
    const at = Date.UTC(2026, 10, 7, 18, 0, 0)
    const rows = await readBridgeAccounts('claude-code', {
      accounts: () => accounts,
      usage: async (id) =>
        usage({
          instanceId: id,
          account: 'someone@example.com',
          windows: [window_('session', id === 'work' ? 95 : 10, at), window_('weekly', 40, at)],
        }),
    })
    expect(rows).toEqual([
      {
        account_id: 'work',
        name: 'Work',
        usage: 'ok',
        session: { used_percent: 95, resets_at: new Date(at).toISOString() },
        weekly: { used_percent: 40, resets_at: new Date(at).toISOString() },
      },
      {
        account_id: 'home',
        name: 'Home',
        usage: 'ok',
        session: { used_percent: 10, resets_at: new Date(at).toISOString() },
        weekly: { used_percent: 40, resets_at: new Date(at).toISOString() },
      },
    ])
    expect(JSON.stringify(rows)).not.toContain('example.com')
    expect(chooseBridgeAccount(rows)).toBe('home')
  })

  it('takes the fullest window of a kind and the soonest reset of it', async () => {
    const early = Date.UTC(2026, 10, 7, 12, 0, 0)
    const late = Date.UTC(2026, 10, 9, 12, 0, 0)
    const [row] = await readBridgeAccounts('claude-code', {
      accounts: () => [accounts[0]],
      usage: async () => usage({ windows: [window_('weekly', 20, late), window_('weekly', 80, early)] }),
    })
    expect(row.weekly).toEqual({ used_percent: 80, resets_at: new Date(early).toISOString() })
  })

  it('reports an account with no subscription window as not_applicable, and an error as unreadable', async () => {
    const rows = await readBridgeAccounts('claude-code', {
      accounts: () => accounts,
      usage: async (id) => usage({ status: id === 'work' ? 'not-applicable' : 'error' }),
    })
    expect(rows.map((r) => r.usage)).toEqual(['not_applicable', 'unreadable'])
    expect(rows.every((r) => r.session.used_percent === null)).toBe(true)
  })

  it('keeps an account whose probe throws, as unreadable', async () => {
    const rows = await readBridgeAccounts('claude-code', {
      accounts: () => accounts,
      usage: async (id) => {
        if (id === 'home') throw new Error('/Users/someone/.claude is unreadable')
        return usage({ windows: [window_('session', 5, null)] })
      },
    })
    expect(rows.map((r) => [r.account_id, r.usage])).toEqual([
      ['work', 'ok'],
      ['home', 'unreadable'],
    ])
    expect(JSON.stringify(rows)).not.toContain('/Users/someone')
    expect(chooseBridgeAccount(rows)).toBe('work')
  })

  it('folds a per-model weekly window into the weekly signal', async () => {
    const [row] = await readBridgeAccounts('claude-code', {
      accounts: () => [accounts[0]],
      usage: async () =>
        usage({ windows: [window_('weekly', 10, null), window_('model', 100, null), window_('session', 5, null)] }),
    })
    expect(row.weekly.used_percent).toBe(100)
    expect(row.session.used_percent).toBe(5)
    expect(chooseBridgeAccount([row])).toBe('work')
  })

  it('answers an account by id with no usage read at all', () => {
    let reads = 0
    const deps = {
      accounts: () => accounts,
      usage: async () => {
        reads += 1
        return usage({})
      },
    }
    expect(bridgeAccountById('claude-code', 'home', deps)).toEqual({ account_id: 'home', name: 'Home' })
    expect(bridgeAccountById('claude-code', 'nope', deps)).toBeNull()
    expect(reads).toBe(0)
  })

  it('answers an empty list for an agent with no enabled account', async () => {
    expect(await readBridgeAccounts('codex', { accounts: () => [], usage: async () => usage({}) })).toEqual([])
    expect(chooseBridgeAccount([])).toBeNull()
  })
})
