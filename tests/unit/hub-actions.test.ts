/**
 * Open from the children strip and the child banner: a chat of the hub that
 * is not open in this window opens on the machine of the one that is, since a
 * parent starts its children on its own backend.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubChatRef } from '../../src/shared/hub'

const openReviewChat = vi.fn(async () => 'opened')
vi.mock('../../src/renderer/components/reviews/review-to-chat', () => ({ openReviewChat }))
const focusComposer = vi.fn()
vi.mock('../../src/renderer/services/composer-registry', () => ({ focusComposer }))

const { openHubChat, nudgeChild } = await import('../../src/renderer/components/hub/hub-actions')
const { useAgentStore } = await import('../../src/renderer/stores/agent-store')
const { useDraftStore } = await import('../../src/renderer/stores/draft-store')

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

describe('nudgeChild', () => {
  beforeEach(() => {
    focusComposer.mockClear()
    useDraftStore.setState({ drafts: {}, pillsBySession: {} })
    // Node has no rAF; the nudge focuses in one.
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      cb(0)
      return 0
    })
  })

  it('appends the chip and puts the caret after it, not where it was before', async () => {
    useDraftStore.getState().setDraft('opened', 'half a sentence')
    await nudgeChild(ref('parent'), ref('child'))
    const draft = useDraftStore.getState().drafts.opened ?? ''
    const pill = useDraftStore.getState().pillsBySession.opened?.[0]
    expect(pill?.label).toBe('To: child')
    expect(draft.endsWith(`[[pill:${pill?.id}]] `)).toBe(true)
    expect(draft.startsWith('half a sentence')).toBe(true)
    expect(focusComposer).toHaveBeenCalledWith('opened', true)
  })
})
