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

function machine(id: string, projects: Project[], live?: LiveStatuses): HomeMachine {
  return { connectionId: id, label: id === 'mac' ? 'Studio Mac' : id, sessions: sessionsFromProjects(projects), live }
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
            { id: 'plan', startedAt: 50 },
          ),
        ]),
      ],
      {
        'mac:approval': thread({ items: [approval('pending')] }),
        'mac:input': thread({ items: [question()] }),
        'mac:plan': thread({ items: [{ kind: 'plan', id: 'p', planId: 'p', markdown: '' }] }),
        'mac:done': thread({ status: 'idle', statusAt: 1, unread: 1 }),
        'mac:working': thread({ status: 'running', statusAt: 2 }),
        'mac:failed': thread({ status: 'error', statusAt: 3 }),
      },
      10,
    )
    expect(page.items.map((r) => [r.id, r.status])).toEqual([
      ['approval', 'Approval'],
      ['input', 'Input'],
      ['plan', 'Plan'],
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
    const page = homeRecents(
      [
        machine('mac', [
          project('/a', { id: 'a', startedAt: 1 }, { id: 'q', startedAt: 2 }, { id: 'p', startedAt: 3 }),
        ]),
      ],
      {
        'mac:a': thread({ items: [approval('approve')] }),
        'mac:q': thread({ items: [question([['yes']])] }),
        'mac:p': thread({
          items: [
            { kind: 'plan', id: 'p', planId: 'p', markdown: '' },
            { kind: 'user', id: 'u', text: 'Implement', at: 1 },
          ],
        }),
      },
    )
    expect(page.items.map((r) => r.status)).toEqual([null, null, null])
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

  it('formats seconds or milliseconds, and nothing for no time', () => {
    const now = Date.now()
    expect(homeRelativeTime(now - 5 * 60_000)).toBe('5m')
    expect(homeRelativeTime(Math.floor((now - 2 * 3_600_000) / 1000))).toBe('2h')
    expect(homeRelativeTime(0)).toBe('')
  })
})
