import { describe, expect, it } from 'vitest'
import { approvalActions } from '../../apps/mobile/src/lib/approval-actions'
import { HOST_WRITE_PHONE_APPROVAL_CAPABILITY } from '../../src/shared/host-write-phone'
import { BACKEND_CAPABILITIES } from '../../src/shared/ws-protocol'
import type { HostWriteCard } from '../../src/shared/agent-host-writes'
import type { FeedItem } from '../../apps/mobile/src/stores/chat'

type Approval = Extract<FeedItem, { kind: 'approval' }>

const card: HostWriteCard = {
  action: 'comment', agentLabel: 'Codex', host: 'github', prLabel: 'app #1', url: null,
  location: 'a.ts:3', quote: null, replyText: 'Log it.', maxChars: 8000,
}
const item = (over: Partial<Approval> = {}): Approval => ({
  kind: 'approval', id: 'a-1', requestId: 'sbmcp_1', toolName: 'x', detail: 'd', requestType: 'tool', state: 'pending', ...over,
})

describe('approvalActions', () => {
  it('approves a pull request write only on a backend that takes a phone approval', () => {
    expect(approvalActions(item({ hostWrite: card }), true)).toMatchObject({ kind: 'host-write', buttons: [{ label: 'Post comment', primary: true }] })
    expect(approvalActions(item({ hostWrite: card }), false)).toEqual({ kind: 'deny-only' })
  })

  it('keeps a card cached with the old flag Deny only, and an ordinary card plain', () => {
    expect(approvalActions(item({ desktopOnly: true }), true)).toEqual({ kind: 'deny-only' })
    expect(approvalActions(item(), false)).toEqual({ kind: 'plain' })
  })

  it('is advertised by every backend host', () => {
    expect(BACKEND_CAPABILITIES).toContain(HOST_WRITE_PHONE_APPROVAL_CAPABILITY)
  })
})
