import { describe, expect, it } from 'vitest'
import type { HubChatRef, HubChatView, HubChildView } from '../../src/shared/hub'
import {
  hubChangeConcerns,
  phoneHubView,
  shownHubChild,
  topLevelChatRows,
} from '../../apps/mobile/src/lib/hub-children'

const ref = (id: string, familyIds = [id]): HubChatRef => ({
  id,
  familyIds,
  title: id,
  agentType: 'codex',
  projectPath: '/p',
  updatedAt: 0,
})

const remoteChild = {
  chat: ref('c1'),
  remote: { machineId: 'vm-1', machine: 'build-vm', connected: true, ageMs: 0, stopping: false },
} as HubChildView

describe('phoneHubView', () => {
  const view: HubChatView = { self: ref('p'), parent: null, children: [remoteChild], state: 'waiting' }

  it('keeps the remote field while hub_remote_children is on', () => {
    expect(phoneHubView(view, true)).toBe(view)
  })

  it('drops it while the flag is off', () => {
    const shown = phoneHubView(view, false)
    expect(shown.children[0]).not.toHaveProperty('remote')
    expect(shown.children[0].chat.id).toBe('c1')
    expect(shown.state).toBe('waiting')
  })
})

describe('shownHubChild', () => {
  it('hides the machine only for display, leaving the child the row routes by unchanged', () => {
    expect(shownHubChild(remoteChild, true)).toBe(remoteChild)
    expect(shownHubChild(remoteChild, false)).not.toHaveProperty('remote')
    expect(remoteChild.remote?.machine).toBe('build-vm')
  })
})

describe('hubChangeConcerns', () => {
  const view: HubChatView = { self: ref('root', ['root', 'live']), parent: ref('hub'), children: [], state: null }

  it('re-reads on any change before the first view', () => {
    expect(hubChangeConcerns(null, 't', 'other')).toBe(true)
  })

  it('re-reads for its own ids and its parent, not for another hub', () => {
    expect(hubChangeConcerns(view, 'live', 'root')).toBe(true)
    expect(hubChangeConcerns(view, 'live', 'live')).toBe(true)
    expect(hubChangeConcerns(view, 'live', 'hub')).toBe(true)
    expect(hubChangeConcerns(view, 'live', 'other')).toBe(false)
  })
})

describe('topLevelChatRows', () => {
  it('leaves out an open child whose parent is listed, in list order', () => {
    const rows = [
      { id: 'child', hub: { parentId: 'parent' } },
      { id: 'parent', hub: { openChildren: 1 } },
      { id: 'orphan', hub: { parentId: 'archived' } },
      { id: 'plain' },
    ]
    expect(topLevelChatRows(rows).map((r) => r.id)).toEqual(['parent', 'orphan', 'plain'])
  })
})
