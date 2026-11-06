import type { Project } from '@shared/types'
import { bridgeOriginLabel } from '@shared/bridge'
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
})
