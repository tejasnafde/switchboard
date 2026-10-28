import { describe, expect, it } from 'vitest'
import { chatIdentity } from '../../src/renderer/components/chat/chat-identity'

describe('chatIdentity', () => {
  it('builds a plain remote breadcrumb with secondary worktree identity', () => {
    expect(
      chatIdentity({
        machineId: 'machine-1',
        machineName: 'Build Mac',
        projectPath: '/Users/dev/switchboard',
        title: 'Calm interface',
        worktreeBranch: 'sb/calm-interface',
      }),
    ).toEqual({
      breadcrumb: ['Build Mac', 'switchboard', 'Calm interface'],
      branch: 'sb/calm-interface',
    })
  })

  it('omits local machine and absent branch metadata', () => {
    expect(
      chatIdentity({
        machineId: 'local',
        projectPath: '/Users/dev/switchboard',
        title: 'Fix keyboard focus',
      }),
    ).toEqual({
      breadcrumb: ['switchboard', 'Fix keyboard focus'],
      branch: null,
    })
  })

  it("puts an open child's parent between the project and the title", () => {
    expect(
      chatIdentity({ projectPath: '/p/acme', parentTitle: 'Ship billing v2', title: 'Webhook retries' }).breadcrumb,
    ).toEqual(['acme', 'Ship billing v2', 'Webhook retries'])
  })
})
