import { describe, expect, it } from 'vitest'
import {
  childStateLabel,
  hubChipText,
  hubNudgeContent,
  nestHubChildren,
  withHubFields,
  type SessionHubField,
} from '../../src/shared/hub'
import { deriveRecentSessions } from '../../src/renderer/components/sidebar/recent-sessions'
import type { SessionSummary } from '../../src/shared/types'

const row = (id: string, hub?: SessionHubField) => ({ id, ...(hub ? { hub } : {}) })

describe('session rows and the sidebar', () => {
  it('marks open children with their parent and parents with their count', () => {
    const rows = withHubFields(
      [row('p'), row('c1'), row('c2'), row('x')],
      [
        { childId: 'c1', parentId: 'p' },
        { childId: 'c2', parentId: 'p' },
      ],
    )
    expect(rows).toEqual([
      row('p', { openChildren: 2 }),
      row('c1', { parentId: 'p' }),
      row('c2', { parentId: 'p' }),
      row('x'),
    ])
  })

  it('nests children under their parent in list order, and keeps an orphan at the top level', () => {
    const nested = nestHubChildren([
      row('c1', { parentId: 'p' }),
      row('x'),
      row('p', { openChildren: 2 }),
      row('c2', { parentId: 'p' }),
      row('orphan', { parentId: 'archived-parent' }),
    ])
    expect(nested.map((n) => [n.session.id, n.children.map((c) => c.id)])).toEqual([
      ['x', []],
      ['p', ['c1', 'c2']],
      ['orphan', []],
    ])
  })

  it('leaves open children out of Recent: they are reached through the parent', () => {
    const session = (id: string, hub?: SessionHubField): SessionSummary => ({
      id,
      source: 'claude-code',
      title: id,
      startedAt: 1,
      messageCount: 0,
      filePath: '',
      ...(hub ? { hub } : {}),
    })
    const items = deriveRecentSessions({
      localProjects: [
        { path: '/p', name: 'p', sessions: [session('p', { openChildren: 1 }), session('c', { parentId: 'p' })] },
      ],
      remoteProjects: {},
      liveSessions: [],
    })
    expect(items.map((i) => i.session.id)).toEqual(['p'])
  })
})

describe('labels', () => {
  it('names child states, a slot wait and a report with subagents still running', () => {
    expect(childStateLabel({ state: 'needs_you', waitingForSlot: false })).toBe('Needs you')
    expect(childStateLabel({ state: 'starting', waitingForSlot: true })).toBe('Waiting for a slot')
    expect(childStateLabel({ state: 'working', reported: true, waitingForSlot: false })).toBe(
      'Reported, subagents still running',
    )
  })

  it('counts children on the chip and adds the parent state when it has one', () => {
    expect(hubChipText({ children: [{}, {}] as never, state: 'waiting' })).toBe(
      'Hub, 2 children · Waiting for children',
    )
    expect(hubChipText({ children: [{}] as never, state: 'idle' })).toBe('Hub, 1 child')
  })

  it('names the child and the relay tool in a Nudge', () => {
    const text = hubNudgeContent({
      id: 'c1',
      familyIds: ['c1'],
      title: 'Usage export',
      agentType: 'codex',
      projectPath: '/p',
      updatedAt: 0,
    })
    expect(text).toContain('"Usage export" (childId: c1)')
    expect(text).toContain('send_agent_message')
  })
})
