/**
 * Open from the children strip and the child banner: a chat of the hub that
 * is not open in this window opens on the machine of the one that is, since a
 * parent starts its children on its own backend.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubChatRef } from '../../src/shared/hub'

const openReviewChat = vi.fn(async () => 'opened')
vi.mock('../../src/renderer/components/reviews/review-to-chat', () => ({ openReviewChat }))
vi.mock('../../src/renderer/services/composer-registry', () => ({ focusComposer: vi.fn() }))

const { openHubChat } = await import('../../src/renderer/components/hub/hub-actions')
const { useAgentStore } = await import('../../src/renderer/stores/agent-store')

const ref = (id: string, familyIds = [id]): HubChatRef => ({
  id,
  familyIds,
  title: id,
  agentType: 'claude-code',
  projectPath: '/srv/app',
  updatedAt: 0,
})

describe('openHubChat', () => {
  beforeEach(() => {
    openReviewChat.mockClear()
    useAgentStore.setState({ sessions: [], activeSessionId: null })
  })

  it("opens a child that is not open on its open parent's machine, under any id of the parent", () => {
    useAgentStore.getState().addSession({ id: 'parent-uuid', type: 'claude-code', status: 'idle', machineId: 'vm' })
    const child = ref('child')
    void openHubChat(child, ref('parent-root', ['parent-root', 'parent-uuid']))
    expect(openReviewChat).toHaveBeenCalledWith(child, 'vm')
  })

  it('stays local when neither chat is open here', () => {
    const parent = ref('parent')
    void openHubChat(parent, ref('child'))
    expect(openReviewChat).toHaveBeenCalledWith(parent, 'local')
  })
})
