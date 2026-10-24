/**
 * Home > Recents rules on the Expo app, the same cases as Android's
 * HomePresentationTest.
 */
import { describe, expect, it } from 'vitest'
import type { Project } from '../../src/shared/types'
import type { FeedItem, ThreadState } from '../../apps/mobile/src/stores/chat'
import {
  homeRecents,
  homeRelativeTime,
  liveStatus,
  newestSessions,
  persistedRecents,
  sessionsFromProjects,
  type HomeMachine,
  type LiveStatuses,
} from '../../apps/mobile/src/lib/home-recents'

type Thread = Pick<ThreadState, 'items' | 'status' | 'statusAt' | 'unread'>

function project(
  path: string,
  ...sessions: Array<{ id: string; startedAt: number; title?: string; worktreePath?: string }>
): Project {
  return {
    path,
    name: path.split('/').pop() ?? path,
    sessions: sessions.map((s) => ({
      id: s.id,
      source: 'claude-code',
      title: s.title ?? s.id,
      startedAt: s.startedAt,
      messageCount: 1,
      filePath: '',
      worktreePath: s.worktreePath,
    })),
  }
}

function machine(id: string, projects: Project[], live?: LiveStatuses, connected = true): HomeMachine {
  return {
    connectionId: id,
    label: id === 'mac' ? 'Studio Mac' : id,
    connected,
    sessions: sessionsFromProjects(projects),
    live,
  }
}

function thread(patch: Partial<Thread> = {}): Thread {
  return { items: [], status: 'connecting', unread: 0, ...patch }
}

const approval = (state: 'pending' | 'approve'): FeedItem => ({
  kind: 'approval',
  id: `a-${state}`,
  requestId: 'r1',
  toolName: 'Bash',
  detail: '',
  requestType: 'command',
  state,
})
const question = (answers?: string[][]): FeedItem => ({
  kind: 'question',
  id: 'q',
  requestId: 'q1',
  questions: [],
  answers,
})

describe('homeRecents', () => {
  it('ranks attention over Working, Failed and Done, and keeps the route fields', () => {
    const page = homeRecents(
      [
        machine('mac', [
          project(
            '/repo',
            { id: 'done', startedAt: 500 },
            { id: 'approval', startedAt: 100, worktreePath: '/repo/.switchboard/worktrees/review' },
            { id: 'input', startedAt: 200 },
            { id: 'working', startedAt: 300 },
            { id: 'failed', startedAt: 400 },
          ),
        ]),
      ],
      {
        'mac:approval': thread({ status: 'running', statusAt: 4, items: [approval('pending')] }),
        'mac:input': thread({ status: 'running', statusAt: 5, items: [question()] }),
        'mac:done': thread({ status: 'idle', statusAt: 1, unread: 1 }),
        'mac:working': thread({ status: 'running', statusAt: 2 }),
        'mac:failed': thread({ status: 'error', statusAt: 3 }),
      },
      10,
    )
    expect(page.items.map((r) => [r.id, r.status])).toEqual([
      ['approval', 'Approval'],
      ['input', 'Input'],
      ['working', 'Working'],
      ['failed', 'Failed'],
      ['done', 'Done'],
    ])
    expect(page.items[0]).toMatchObject({
      worktreePath: '/repo/.switchboard/worktrees/review',
      projectPath: '/repo',
      projectName: 'repo',
      connectionLabel: 'Studio Mac',
    })
  })

  it('orders chats without a status newest first and names an untitled chat', () => {
    const page = homeRecents(
      [machine('mac', [project('/a', { id: 'old', startedAt: 1 }, { id: 'new', startedAt: 9, title: '  ' })])],
      {},
    )
    expect(page.items.map((r) => [r.id, r.title, r.status])).toEqual([
      ['new', 'Untitled chat', null],
      ['old', 'old', null],
    ])
  })

  it('lists a chat once per machine but keeps the same id on another machine', () => {
    const shared = project('/a', { id: 't', startedAt: 1 })
    const page = homeRecents(
      [machine('mac', [shared, project('/b', { id: 't', startedAt: 1 })]), machine('vm', [shared])],
      {},
    )
    expect(page.items.map((r) => `${r.connectionId}:${r.id}`)).toEqual(['mac:t', 'vm:t'])
  })

  it('returns one page and the total', () => {
    const sessions = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, startedAt: i }))
    const page = homeRecents([machine('mac', [project('/a', ...sessions)])], {})
    expect(page.items.map((r) => r.id)).toEqual(['t6', 't5', 't4', 't3', 't2'])
    expect(page.total).toBe(7)
    expect(homeRecents([machine('mac', [project('/a', ...sessions)])], {}, 10).items).toHaveLength(7)
  })

  it('drops attention once the card is answered', () => {
    const page = homeRecents([machine('mac', [project('/a', { id: 'a', startedAt: 1 }, { id: 'q', startedAt: 2 })])], {
      'mac:a': thread({ status: 'idle', statusAt: 1, items: [approval('approve')] }),
      'mac:q': thread({ status: 'idle', statusAt: 2, items: [question([['yes']])] }),
    })
    expect(page.items.map((r) => r.status)).toEqual([null, null])
  })

  it('reads attention from the feed only for a chat live this run, and never a plan', () => {
    const page = homeRecents(
      [
        machine('mac', [
          project(
            '/a',
            { id: 'cached', startedAt: 1 },
            { id: 'plan', startedAt: 2 },
            { id: 'err', startedAt: 3 },
            { id: 'stop', startedAt: 4 },
          ),
        ]),
      ],
      {
        'mac:cached': thread({ items: [approval('pending')] }),
        'mac:plan': thread({
          status: 'idle',
          statusAt: 1,
          items: [{ kind: 'plan', id: 'p', planId: 'p', markdown: '' }],
        }),
        'mac:err': thread({ status: 'error', statusAt: 2, items: [approval('pending')] }),
        'mac:stop': thread({ status: 'stopped', statusAt: 3, items: [question()] }),
      },
    )
    expect(page.items.map((r) => [r.id, r.status])).toEqual([
      ['err', 'Failed'],
      ['stop', null],
      ['plan', null],
      ['cached', null],
    ])
  })

  it('shows no live status or attention for a machine that is not connected', () => {
    const page = homeRecents(
      [
        machine(
          'mac',
          [project('/a', { id: 'w', startedAt: 1 }, { id: 'r', startedAt: 2 })],
          { mark: 0, statuses: { r: 'running' } },
          false,
        ),
      ],
      { 'mac:w': thread({ status: 'running', statusAt: 1, items: [approval('pending')] }) },
    )
    expect(page.items.map((r) => r.status)).toEqual([null, null])
  })
})

describe('liveStatus', () => {
  it('shows nothing for a status restored from disk', () => {
    expect(liveStatus('t', thread({ status: 'running' }), undefined)).toBeNull()
    const page = homeRecents([machine('mac', [project('/a', { id: 't', startedAt: 1 })])], {
      'mac:t': thread({ status: 'running' }),
    })
    expect(page.items[0].status).toBeNull()
  })

  it('takes a live status set this run', () => {
    expect(liveStatus('t', thread({ status: 'running', statusAt: 4 }), undefined)).toBe('running')
  })

  it('takes the list-sessions reply, and a missing thread has no live session', () => {
    const live = { mark: 10, statuses: { t: 'running' } }
    expect(liveStatus('t', undefined, live)).toBe('running')
    expect(liveStatus('t', thread({ status: 'idle', statusAt: 3 }), live)).toBe('running')
    expect(liveStatus('gone', thread({ status: 'running', statusAt: 3 }), live)).toBeNull()
  })

  it('keeps a live change made after the reply was asked for, both ways', () => {
    expect(liveStatus('t', thread({ status: 'idle', statusAt: 11 }), { mark: 10, statuses: { t: 'running' } })).toBe(
      'idle',
    )
    expect(liveStatus('t', thread({ status: 'running', statusAt: 11 }), { mark: 10, statuses: {} })).toBe('running')
  })
})

describe('helpers', () => {
  it('keeps the newest chats for the disk cache', () => {
    const sessions = sessionsFromProjects([
      project('/a', { id: 'a', startedAt: 1 }, { id: 'b', startedAt: 3 }, { id: 'c', startedAt: 2 }),
    ])
    expect(newestSessions(sessions, 2).map((s) => s.id)).toEqual(['b', 'c'])
  })

  it('writes the newest 50 chats per machine and never the demo', () => {
    const many = sessionsFromProjects([
      project('/a', ...Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, startedAt: i }))),
    ])
    const out = persistedRecents({ mac: many, demo: many }, 50)
    expect(Object.keys(out)).toEqual(['mac'])
    expect(out.mac).toHaveLength(50)
    expect(out.mac[0].id).toBe('t59')
  })

  it('formats seconds or milliseconds, and nothing for no time', () => {
    const now = Date.now()
    expect(homeRelativeTime(now - 5 * 60_000)).toBe('5m')
    expect(homeRelativeTime(Math.floor((now - 2 * 3_600_000) / 1000))).toBe('2h')
    expect(homeRelativeTime(0)).toBe('')
    const eightDays = now - 8 * 24 * 3_600_000
    expect(homeRelativeTime(eightDays, now)).toBe(
      new Date(eightDays).toLocaleDateString(undefined, { dateStyle: 'short' }),
    )
  })
})
