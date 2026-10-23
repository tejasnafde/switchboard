import { describe, it, expect } from 'vitest'
import { eventRowCopy } from '../../apps/mobile/src/lib/event-rows'

const time = (ms: number) => `t${ms}`

describe('eventRowCopy', () => {
  it('words a retry by whether it is still running', () => {
    const retry = { kind: 'retry', id: 'r-1', turnId: '1', message: 'Overloaded' } as const
    expect(eventRowCopy({ ...retry, active: true }, time)).toEqual({ title: 'Retrying', lines: ['Overloaded'] })
    expect(eventRowCopy({ ...retry, active: false }, time).title).toBe('Retry finished')
  })

  it('names the branch and the path of a drift', () => {
    expect(eventRowCopy({ kind: 'drift', id: 'drift', worktreePath: '/r/a', branch: 'a' }, time)).toEqual({
      title: 'Worktree changed',
      lines: ['a', '/r/a'],
    })
  })

  it('lists what is known about a spend block and skips what is not', () => {
    const block = {
      kind: 'spendBlocked',
      id: 's',
      instanceId: 'work',
      model: 'claude-fable-5',
      reason: 'org_level_disabled',
      scope: 'org',
      resetsAtMs: 7,
    } as const
    expect(eventRowCopy(block, time)).toEqual({
      title: 'Spend blocked',
      lines: ['work · claude-fable-5', 'org_level_disabled', 'scope: org', 'resets: t7'],
    })
    expect(eventRowCopy({ ...block, instanceId: null, reason: null, resetsAtMs: null }, time).lines).toEqual([
      'claude-fable-5',
      'scope: org',
    ])
  })

  it('heads a peer message with its direction and the other chat', () => {
    const peer = {
      kind: 'peer',
      id: 'h-1',
      initiator: 'agent',
      peerThreadId: 'agent_2',
      peerLabel: 'Roadmap',
      text: 'Found it',
      at: 1,
    } as const
    expect(eventRowCopy({ ...peer, direction: 'received' }, time)).toEqual({
      title: 'Received · Roadmap',
      lines: ['Found it'],
      meta: 'agent · agent_2',
    })
    expect(eventRowCopy({ ...peer, direction: 'sent' }, time).title).toBe('Sent · Roadmap')
  })
})
