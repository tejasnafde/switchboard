import type { Project } from '@shared/types'
import { bridgeChecksLabel, bridgeOriginLabel } from '@shared/bridge'
import { sessionsFromProjects } from '../home-recents'

const base = { source: 'claude-code' as const, messageCount: 1, filePath: '', startedAt: 1 }

function sessions(extra: Record<string, unknown>[]) {
  const project = {
    path: '/repo',
    name: 'repo',
    sessions: extra.map((e, i) => ({ ...base, id: `c${i}`, title: `Chat ${i}`, ...e })),
  } as unknown as Project
  return sessionsFromProjects([project])
}

describe('bridge origin on Home > Recents', () => {
  it('keeps the marker and its stop state, and leaves other chats unmarked', () => {
    const rows = sessions([
      {},
      { bridgeOrigin: { stop: null } },
      { bridgeOrigin: { stop: 'pending' } },
      { bridgeOrigin: { stop: 'stopped' } },
      { bridgeOrigin: { stop: 'unconfirmed' } },
    ])
    expect(rows.map((r) => r.bridgeOrigin)).toEqual([
      undefined,
      { stop: null },
      { stop: 'pending' },
      { stop: 'stopped' },
      { stop: 'unconfirmed' },
    ])
    expect(rows.slice(1).map((r) => bridgeOriginLabel(r.bridgeOrigin!))).toEqual([
      'From the bridge',
      'Bridge stop pending',
      'Bridge stopped',
      'Bridge stop not confirmed',
    ])
  })

  it('drops a marker it cannot read instead of guessing', () => {
    const rows = sessions([{ bridgeOrigin: 'yes' }, { bridgeOrigin: { stop: 'gone' } }, { bridgeOrigin: [] }])
    expect(rows.map((r) => r.bridgeOrigin)).toEqual([undefined, undefined, undefined])
  })

  it('reads a marker with no stop field as a plain bridge chat', () => {
    expect(sessions([{ bridgeOrigin: {} }])[0].bridgeOrigin).toEqual({ stop: null })
  })

  it('carries the measured check summary and names what it says', () => {
    const rows = sessions([
      { bridgeOrigin: { stop: null, checks: { status: 'measured', passed: 2, failed: 0 } } },
      { bridgeOrigin: { stop: null, checks: { status: 'measured', passed: 1, failed: 1 } } },
      { bridgeOrigin: { stop: null, checks: { status: 'stale', passed: 1, failed: 0 } } },
      { bridgeOrigin: { stop: null, checks: { status: 'not_measured', passed: 0, failed: 0 } } },
      { bridgeOrigin: { stop: null, checks: { status: 'unavailable', passed: 0, failed: 0 } } },
    ])
    expect(rows.map((r) => bridgeChecksLabel(r.bridgeOrigin!.checks!))).toEqual([
      '2 checks passed',
      '1 check failed',
      'Checks not measured on this code',
      'Checks not measured',
      'Checks could not run',
    ])
  })

  it('drops a check summary it cannot read and keeps the rest of the marker', () => {
    const rows = sessions([
      { bridgeOrigin: { stop: 'pending', checks: { status: 'green', passed: 1, failed: 0 } } },
      { bridgeOrigin: { stop: null, checks: 'measured' } },
    ])
    expect(rows.map((r) => r.bridgeOrigin)).toEqual([{ stop: 'pending' }, { stop: null }])
  })
})
