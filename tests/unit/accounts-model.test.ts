import { describe, expect, it } from 'vitest'
import type { ProviderInstance } from '../../src/shared/types'
import { buildWindow, type ProviderUsage } from '../../src/shared/provider-usage'
import {
  accountsSummary,
  barTone,
  credentialSummary,
  defaultAccountId,
  readSettings,
  roomLeft,
  sortByRoomLeft,
  stableOrder,
  untilReset,
} from '../../src/renderer/components/settings/accounts-model'

const NOW = Date.UTC(2026, 8, 25, 12, 0)
const MIN = 60_000

function inst(id: string, extra: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id, agentType: 'claude-code', displayName: id, accentColor: null, authMode: 'oauth_dir', envKeys: [],
    oauthDir: `/h/.claude-${id}`, effectiveOauthDir: `/h/.claude-${id}`, effectiveOauthDirSource: 'oauth_dir',
    enabled: true, createdAt: 0, updatedAt: 0, ...extra,
  }
}

function usage(id: string, status: ProviderUsage['status'], windows: [number, number][] = []): ProviderUsage {
  return {
    instanceId: id, agentType: 'claude-code', status, plan: null, account: null, overage: [], fetchedAtMs: NOW,
    windows: windows.map(([percent, resetIn], i) => buildWindow({
      id: `w${i}`, label: i === 0 ? '5-hour session' : 'Weekly', kind: 'other', percent,
      resetsAtMs: NOW + resetIn * MIN, windowMinutes: null,
    })),
    ...(status === 'ok' ? {} : { message: 'the sign-in expired' }),
  }
}

describe('barTone', () => {
  it('is ok under 75, amber from 75, red from 90', () => {
    const tone = (p: number | null) => barTone(buildWindow({ id: 'w', label: 'W', kind: 'other', percent: p, resetsAtMs: null, windowMinutes: null }))
    expect([tone(null), tone(74), tone(75), tone(89), tone(90), tone(100)]).toEqual(['ok', 'ok', 'warn', 'warn', 'bad', 'bad'])
  })

  it('is red for a window the provider marks reached, whatever its number', () => {
    expect(barTone({ usedPercent: 16, severity: 'critical' })).toBe('bad')
  })
})

describe('untilReset', () => {
  it('counts minutes, then hours and minutes, then shows the date', () => {
    expect(untilReset(null, NOW)).toBe('')
    expect(untilReset(NOW - MIN, NOW)).toBe('now')
    expect(untilReset(NOW + 40 * MIN, NOW)).toBe('in 40 min')
    expect(untilReset(NOW + 182 * MIN, NOW)).toBe('in 3 h 02 min')
    // Local noon, so the date is 2 Oct in every host time zone.
    expect(untilReset(new Date(2026, 9, 2, 12).getTime(), NOW)).toBe('Fri 2 Oct')
  })
})

describe('sortByRoomLeft', () => {
  it('puts the most room first, unreported next, attention last', () => {
    const list = [inst('out'), inst('full'), inst('none'), inst('free'), inst('broken')]
    const usages = {
      out: usage('out', 'unauthenticated'),
      full: usage('full', 'ok', [[42, 10], [81, 100]]),
      none: usage('none', 'not-applicable'),
      free: usage('free', 'ok', [[1, 10], [0, 100]]),
      broken: usage('broken', 'error'),
    }
    expect(sortByRoomLeft(list, usages).map((i) => i.id)).toEqual(['free', 'full', 'none', 'out', 'broken'])
    expect(roomLeft(usages.full)).toBe(19)
    expect(roomLeft(usages.none)).toBeNull()
  })
})

describe('accountsSummary', () => {
  it('names the roomiest account, the soonest reset and who needs attention', () => {
    const list = [inst('tejas'), inst('akshaya'), inst('aditya')]
    const summary = accountsSummary(list, {
      tejas: usage('tejas', 'ok', [[42, 134], [81, 3000]]),
      akshaya: usage('akshaya', 'ok', [[1, 280], [0, 9000]]),
      aditya: usage('aditya', 'unauthenticated'),
    }, NOW)
    expect(summary.mostRoom).toEqual({ value: 'akshaya', detail: '5-hour session 1%, Weekly 0%' })
    expect(summary.nextReset).toEqual({ value: 'in 2 h 14 min', detail: 'tejas, 5-hour session' })
    expect(summary.attention).toEqual({ count: 1, value: '1 account', detail: 'aditya is signed out' })
  })

  it('says so when nothing is reported and nobody needs attention', () => {
    const summary = accountsSummary([inst('a')], { a: usage('a', 'not-applicable') }, NOW)
    expect(summary.mostRoom).toEqual({ value: '-', detail: 'No usage reported yet' })
    expect(summary.nextReset).toEqual({ value: '-', detail: 'No reset times reported' })
    expect(summary.attention).toMatchObject({ count: 0, value: 'None' })
  })

  it('shows a placeholder, not "None", while a first reading is outstanding', () => {
    const summary = accountsSummary([inst('a'), inst('b')], { a: usage('a', 'not-applicable') }, NOW)
    const pending = { value: '-', detail: 'Reading usage…' }
    expect(summary.mostRoom).toEqual(pending)
    expect(summary.nextReset).toEqual(pending)
    expect(summary.attention).toEqual({ count: 0, ...pending })
  })

  it('keeps what is known while other readings are outstanding', () => {
    const summary = accountsSummary([inst('a'), inst('b')], { a: usage('a', 'unauthenticated') }, NOW)
    expect(summary.attention).toMatchObject({ count: 1, value: '1 account' })
  })
})

describe('stableOrder', () => {
  const ids = (list: ProviderInstance[]) => list.map((i) => i.id)
  const list = [inst('full'), inst('free'), inst('out')]

  it('sorts by the readings at hand the first time', () => {
    expect(ids(stableOrder([], list, {}))).toEqual(['full', 'free', 'out'])
    expect(ids(stableOrder([], list, {
      full: usage('full', 'ok', [[80, 10]]),
      free: usage('free', 'ok', [[5, 10]]),
      out: usage('out', 'unauthenticated'),
    }))).toEqual(['free', 'full', 'out'])
  })

  it('keeps the cards shown in place as readings land and change', () => {
    const shown = ['full', 'free', 'out']
    const usages = { full: usage('full', 'ok', [[99, 10]]), free: usage('free', 'ok', [[1, 10]]) }
    expect(ids(stableOrder(shown, list, usages))).toEqual(shown)
  })

  it('appends new accounts, sorted among themselves, and drops removed ones', () => {
    const next = [inst('free'), inst('full'), inst('late'), inst('later')]
    const usages = { late: usage('late', 'ok', [[90, 10]]), later: usage('later', 'ok', [[10, 10]]) }
    expect(ids(stableOrder(['full', 'out', 'free'], next, usages))).toEqual(['full', 'free', 'later', 'late'])
  })
})

describe('defaultAccountId', () => {
  const list = [inst('claude-code-default'), inst('work'), inst('cx', { agentType: 'codex' })]

  it('follows the stored machine default while it names an account of this kind', () => {
    expect(defaultAccountId('claude-code', list, { scoped: 'work' })).toBe('work')
    expect(defaultAccountId('claude-code', list, { legacy: 'work' })).toBe('work')
  })

  it('falls back to the structural default for a deleted or wrong-kind id', () => {
    expect(defaultAccountId('claude-code', list, { scoped: 'gone' })).toBe('claude-code-default')
    expect(defaultAccountId('claude-code', list, { legacy: 'cx' })).toBe('claude-code-default')
    expect(defaultAccountId('claude-code', list, {})).toBe('claude-code-default')
  })
})

describe('credentialSummary', () => {
  it('shows the folder, the API key names, or the shell environment', () => {
    expect(credentialSummary(inst('a'))).toBe('/h/.claude-a')
    expect(credentialSummary(inst('b', { authMode: 'env', envKeys: ['ANTHROPIC_API_KEY'] }))).toBe('API key (ANTHROPIC_API_KEY)')
    expect(credentialSummary(inst('c', { agentType: 'opencode', authMode: 'env' }))).toBe('Shell environment')
  })
})

describe('readSettings', () => {
  it('keeps the values that were read when one key fails', async () => {
    const boom = new Error('ipc down')
    const result = await readSettings(['a', 'b', 'c'], async (key) => {
      if (key === 'b') throw boom
      return key === 'c' ? null : `value-${key}`
    })
    expect(result).toEqual({ values: { a: 'value-a' }, failed: [{ key: 'b', reason: boom }] })
  })
})
