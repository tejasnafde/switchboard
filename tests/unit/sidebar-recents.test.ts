import { describe, expect, it } from 'vitest'
import { deriveRecentSessions } from '../../src/renderer/components/sidebar/recentSessions'
import type { Project } from '@shared/types'

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
          messages: [
            {
              id: 'request',
              role: 'system',
              content: '',
              timestamp: 50,
              approval: { toolName: 'Bash', detail: 'npm test', status: 'pending' },
            },
          ],
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
          messages: [{
            id: 'approval-request',
            role: 'system',
            content: '',
            timestamp: 50,
            approval: { toolName: 'Bash', detail: 'npm test', status: 'pending' },
          }],
        },
        {
          id: 'input',
          machineId: 'local',
          status: 'idle',
          messages: [{
            id: 'question-request',
            role: 'system',
            content: '',
            timestamp: 500,
            question: { requestId: 'question', questions: [], status: 'pending' },
          }],
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
      ['running', 'working'],
      ['approval', 'failed'],
      ['recent', 'done'],
    ])
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
})
