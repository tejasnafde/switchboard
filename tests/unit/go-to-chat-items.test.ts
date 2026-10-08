import { describe, expect, it } from 'vitest'
import { goToChatItems } from '../../src/renderer/components/go-to-chat-items'
import type { Project, SessionSummary } from '@shared/types'

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, source: 'claude-code', title: id, startedAt: 1, messageCount: 0, filePath: '', ...extra })

const project = (path: string, sessions: SessionSummary[]): Project => ({ path, name: path.split('/').pop()!, sessions })

describe('goToChatItems', () => {
  it('lists local, remote and archived chats once each, with their agent', () => {
    const items = goToChatItems({
      localProjects: [project('/r/app', [session('a', { agentType: 'codex' }), session('t', { agentType: 'terminal', source: 'switchboard' })])],
      remoteProjects: { vm: [project('/srv/api', [session('b')])] },
      archived: [
        { id: 'z', project_path: '/r/app', title: 'Old', updated_at: 5, agent_type: 'opencode', origin_source: null },
        { id: 'y', project_path: '/gone/proj', title: 'Older', updated_at: 4 },
        { id: 'a', project_path: '/r/app', title: 'dup', updated_at: 3 },
      ],
    })
    expect(items.map((i) => [i.session.id, i.machineId, i.agent, i.projectName, !!i.archived])).toEqual([
      ['a', 'local', 'codex', 'app', false],
      ['t', 'local', 'terminal', 'app', false],
      ['b', 'vm', 'claude-code', 'api', false],
      ['z', 'local', 'opencode', 'app', true],
      ['y', 'local', 'claude-code', 'proj', true],
    ])
    expect(items.find((i) => i.session.id === 'z')?.session.source).toBe('opencode')
  })
})
