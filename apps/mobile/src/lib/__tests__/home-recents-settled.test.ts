import type { Project } from '@shared/types'
import { homeRecents, sessionsFromProjects, type HomeMachine } from '../home-recents'

const project: Project = {
  path: '/repo',
  name: 'repo',
  sessions: [
    {
      id: 'settled',
      source: 'claude-code',
      title: 'Settled',
      startedAt: 100,
      settledAt: 200,
      messageCount: 1,
      filePath: '',
    },
    {
      id: 'newer',
      source: 'claude-code',
      title: 'Newer',
      startedAt: 300,
      settledAt: 200,
      messageCount: 1,
      filePath: '',
    },
    { id: 'plain', source: 'claude-code', title: 'Plain', startedAt: 50, messageCount: 1, filePath: '' },
  ],
}

function machine(statuses: Record<string, string> = {}): HomeMachine {
  return {
    connectionId: 'mac',
    label: 'Studio Mac',
    connected: true,
    sessions: sessionsFromProjects([project]),
    live: { mark: 0, statuses },
  }
}

describe('settled chats on Home > Recents', () => {
  it('leaves out a chat settled on the desktop until it has newer activity', () => {
    const page = homeRecents([machine()], {}, 10)
    expect(page.items.map((row) => row.id)).toEqual(['newer', 'plain'])
    expect(page.total).toBe(2)
  })

  it('still lists a settled chat while it works', () => {
    const page = homeRecents([machine({ settled: 'running' })], {}, 10)
    expect(page.items.map((row) => [row.id, row.status])).toContainEqual(['settled', 'Working'])
  })
})
