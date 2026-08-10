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
      limit: 4,
    })

    expect(result.map((item) => item.session.id)).toEqual(['approval', 'running', 'recent'])
    expect(result[0].attentionLabel).toBe('Approval')
  })

  it('includes remote projects and deduplicates only within one machine', () => {
    const duplicate = project().sessions[0]
    const result = deriveRecentSessions({
      localProjects: [{ ...project(), sessions: [duplicate, { ...duplicate }] }],
      remoteProjects: {
        vm: [{ path: '/repo', name: 'remote-repo', sessions: [{ ...duplicate, title: 'Remote copy', startedAt: 400 }] }],
      },
      liveSessions: [],
      limit: 4,
    })

    expect(result.map((item) => `${item.machineId}:${item.session.title}`)).toEqual([
      'vm:Remote copy',
      'local:Recent',
    ])
  })
})
