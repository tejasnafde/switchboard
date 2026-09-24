import { describe, expect, it } from 'vitest'
import { deriveRecentSessions, recentLiveSignal } from '../../src/renderer/components/sidebar/recent-sessions'
import type { Project } from '@shared/types'
import type { PendingBlockingEvent } from '@shared/pending-requests'

function approvalOpened(threadId: string): PendingBlockingEvent {
  return { type: 'request.opened', threadId, requestId: `req-${threadId}`, requestType: 'command', toolName: 'Bash', detail: 'npm test' }
}

function project(): Project {
  return {
    path: '/repo',
    name: 'repo',
    sessions: [
      { id: 'recent', source: 'switchboard', title: 'Recent', startedAt: 300, messageCount: 1, filePath: '' },
      { id: 'running', source: 'switchboard', title: 'Running', startedAt: 100, messageCount: 1, filePath: '' },
      { id: 'approval', source: 'switchboard', title: 'Approval', startedAt: 50, messageCount: 1, filePath: '' },
    ],
  }
}

describe('deriveRecentSessions', () => {
  it('orders actionable sessions before running sessions and ordinary recency', () => {
    const result = deriveRecentSessions({
      localProjects: [project()],
      remoteProjects: {},
      liveSessions: [
        {
          id: 'running',
          machineId: 'local',
          status: 'running',
          messages: [],
        },
        {
          id: 'approval',
          machineId: 'local',
          status: 'idle',
          messages: [],
          pendingRequests: [approvalOpened('approval')],
        },
      ],
    })

    expect(result.map((item) => item.session.id)).toEqual(['approval', 'running', 'recent'])
    expect(result[0].status).toBe('approval')
  })

  it('orders approvals before input even when the input is newer', () => {
    const inputSession = {
      id: 'input', source: 'switchboard' as const, title: 'Input', startedAt: 500, messageCount: 1, filePath: '',
    }
    const result = deriveRecentSessions({
      localProjects: [{ ...project(), sessions: [...project().sessions, inputSession] }],
      remoteProjects: {},
      liveSessions: [
        {
          id: 'approval',
          machineId: 'local',
          status: 'idle',
          messages: [],
          pendingRequests: [approvalOpened('approval')],
        },
        {
          id: 'input',
          machineId: 'local',
          status: 'idle',
          messages: [],
          pendingRequests: [{ type: 'question.asked', threadId: 'input', requestId: 'question', questions: [] }],
        },
      ],
    })

    expect(result.slice(0, 2).map((item) => item.session.id)).toEqual(['approval', 'input'])
  })

  it('includes remote projects and deduplicates only within one machine', () => {
    const duplicate = project().sessions[0]
    const result = deriveRecentSessions({
      localProjects: [{ ...project(), sessions: [duplicate, { ...duplicate }] }],
      remoteProjects: {
        vm: [{ path: '/repo', name: 'remote-repo', sessions: [{ ...duplicate, title: 'Remote copy', startedAt: 400 }] }],
      },
      liveSessions: [],
    })

    expect(result.map((item) => `${item.machineId}:${item.session.title}`)).toEqual([
      'vm:Remote copy',
      'local:Recent',
    ])
  })

  it('uses semantic status priority and marks unseen completions done', () => {
    const result = deriveRecentSessions({
      localProjects: [project()],
      remoteProjects: {},
      liveSessions: [
        { id: 'recent', machineId: 'local', status: 'idle', messages: [], unreadCount: 2 },
        { id: 'running', machineId: 'local', status: 'thinking', messages: [], unreadCount: 0 },
        { id: 'approval', machineId: 'local', status: 'error', messages: [], unreadCount: 0 },
      ],
    })

    expect(result.map((item) => [item.session.id, item.status])).toEqual([
      ['approval', 'failed'],
      ['running', 'working'],
      ['recent', 'done'],
    ])
  })

  it('surfaces the agent digest as previewLine when the last assistant message has one', () => {
    const result = deriveRecentSessions({
      localProjects: [project()],
      remoteProjects: {},
      liveSessions: [
        {
          id: 'running',
          machineId: 'local',
          status: 'running',
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              content: 'I will start by looking at <agent_digest>Reading cost tracking code</agent_digest>',
              timestamp: 100,
            },
          ],
        },
      ],
    })

    expect(result.find((item) => item.session.id === 'running')?.previewLine).toBe(
      'Reading cost tracking code',
    )
  })

  it('falls back to a truncated raw preview when the assistant reported no digest', () => {
    const longText = 'a'.repeat(120)
    const result = deriveRecentSessions({
      localProjects: [project()],
      remoteProjects: {},
      liveSessions: [
        {
          id: 'running',
          machineId: 'local',
          status: 'running',
          messages: [{ id: 'm1', role: 'assistant', content: longText, timestamp: 100 }],
        },
      ],
    })

    const preview = result.find((item) => item.session.id === 'running')?.previewLine
    expect(preview).toBeDefined()
    expect(preview!.length).toBe(70)
  })

  it('leaves previewLine undefined for a session with no live entry', () => {
    const result = deriveRecentSessions({
      localProjects: [project()],
      remoteProjects: {},
      liveSessions: [],
    })

    expect(result.every((item) => item.previewLine === undefined)).toBe(true)
  })

  it('marks a retained worktree recovery as failed without a live chat session', () => {
    const recoverable = {
      id: 'recoverable',
      source: 'claude-code' as const,
      title: 'Recover retained worktree',
      startedAt: 600,
      messageCount: 0,
      filePath: '',
      worktreeCreationId: 'creation-retained',
      worktreeRecovery: {
        status: 'cleanup_required' as const,
        cleanupDisposition: 'retained' as const,
      },
    }
    const result = deriveRecentSessions({
      localProjects: [{ ...project(), sessions: [...project().sessions, recoverable] }],
      remoteProjects: {},
      liveSessions: [],
    })

    expect(result.find((item) => item.session.id === 'recoverable')).toMatchObject({
      status: 'failed',
    })
  })

  it('takes needs-you from the backend pending requests, not from transcript cards', () => {
    const result = deriveRecentSessions({
      localProjects: [project()],
      remoteProjects: {},
      liveSessions: [
        {
          id: 'recent',
          machineId: 'local',
          status: 'idle',
          messages: [{
            id: 'approval_old',
            role: 'assistant',
            content: '',
            timestamp: 1,
            approval: { toolName: 'Bash', detail: 'npm test', status: 'pending' },
          }],
        },
        {
          id: 'running',
          machineId: 'local',
          status: 'idle',
          messages: [],
          pendingRequests: [{ type: 'plan.proposed', threadId: 'running', planId: 'p1', planMarkdown: '# Plan' }],
        },
      ],
    })

    expect(result.find((item) => item.session.id === 'recent')?.status).toBeUndefined()
    expect(result.find((item) => item.session.id === 'running')?.status).toBe('plan')
  })

  it('writes line 2 from what the chat waits on, then the preview, then the project', () => {
    const result = deriveRecentSessions({
      localProjects: [project()],
      remoteProjects: {},
      liveSessions: [
        { id: 'approval', machineId: 'local', status: 'idle', messages: [], pendingRequests: [approvalOpened('approval')] },
        {
          id: 'running',
          machineId: 'local',
          status: 'idle',
          messages: [],
          pendingRequests: [{
            type: 'question.asked',
            threadId: 'running',
            requestId: 'q1',
            questions: [{ id: 'q', header: 'Region', question: 'Which region is the default?', options: [], multiSelect: false }],
          }],
        },
        {
          id: 'recent',
          machineId: 'local',
          status: 'idle',
          messages: [{ id: 'm1', role: 'assistant', content: '<agent_digest>Done: tests green</agent_digest>', timestamp: 1 }],
        },
      ],
    })
    const line = (id: string) => result.find((item) => item.session.id === id)?.statusLine

    expect(line('approval')).toBe('Waiting on your approval: Bash')
    expect(line('running')).toBe('Question: Which region is the default?')
    expect(line('recent')).toBe('Done: tests green')

    const unopened = deriveRecentSessions({ localProjects: [project()], remoteProjects: {}, liveSessions: [] })
    expect(unopened.every((item) => item.statusLine === 'repo')).toBe(true)
  })

  it('changes the refresh signal when a card keeps its id but shows a new tool or question', () => {
    const base = { id: 'a', machineId: 'local', status: 'idle' as const, messages: [] }
    const approval = approvalOpened('a')
    const signal = (pendingRequests: PendingBlockingEvent[]) => recentLiveSignal([{ ...base, pendingRequests }])
    const question = (text: string): PendingBlockingEvent => ({
      type: 'question.asked',
      threadId: 'a',
      requestId: 'q',
      questions: [{ id: 'q', header: 'h', question: text, options: [], multiSelect: false }],
    })

    expect(signal([approval])).not.toBe(signal([{ ...approval, toolName: 'Write' } as PendingBlockingEvent]))
    expect(signal([question('Which region?')])).not.toBe(signal([question('Which bucket?')]))
    expect(signal([approval])).toBe(signal([{ ...approval, detail: 'other' } as PendingBlockingEvent]))
  })

  it('changes the refresh signal when history hydrates, but not while a message streams', () => {
    const base = { id: 'a', machineId: 'local', status: 'idle' as const, unreadCount: 0 }
    const message = (id: string, content: string) => ({ id, role: 'assistant' as const, content, timestamp: 1 })
    const empty = recentLiveSignal([{ ...base, messages: [] }])
    const hydrated = recentLiveSignal([{ ...base, messages: [message('m1', 'Hi'), message('m2', 'Done')] }])
    const streamed = recentLiveSignal([{ ...base, messages: [message('m1', 'Hi'), message('m2', 'Done, and more')] }])

    expect(hydrated).not.toBe(empty)
    expect(streamed).toBe(hydrated)
  })
})
