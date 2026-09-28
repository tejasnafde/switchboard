import { describe, expect, it } from 'vitest'
import { approvalActions } from '../../apps/mobile/src/lib/approval-actions'
import { approvalChoiceOnly, HOST_WRITE_PHONE_APPROVAL_CAPABILITY, hostWritePreview } from '../../src/shared/host-write-phone'
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

  it('sends a card the phone cannot show in full to the desktop', () => {
    expect(approvalActions(item({ hostWrite: { ...card, replyText: undefined } }), true)).toEqual({ kind: 'deny-only' })
  })

  it('is advertised by every backend host', () => {
    expect(BACKEND_CAPABILITIES).toContain(HOST_WRITE_PHONE_APPROVAL_CAPABILITY)
  })
})

describe('hostWritePreview', () => {
  it('holds every word a review posts, uncapped, each comment under its place', () => {
    const text = 'y'.repeat(2_000)
    const preview = hostWritePreview({
      ...card, action: 'review', location: null, replyText: undefined,
      review: { summary: 'Sum.', verdicts: ['comment'], comments: [{ id: 'c1', path: 'a.ts', side: 'old', line: 9, startLine: 4, text, excerpt: [] }] },
    })
    expect(preview).toEqual({ long: true, sections: [{ label: 'Summary', text: 'Sum.' }, { label: 'a.ts:4-9 (old)', text }] })
  })

  it('shows a pull request\'s title and whole description, and a short reply open', () => {
    const description = 'd'.repeat(900)
    expect(hostWritePreview({
      ...card, action: 'create', replyText: undefined,
      create: { repoLabel: 'acme/app', sourceBranch: 'feat', targetBranch: 'main', title: 'Add it', description, draft: false },
    })?.sections).toEqual([
      { label: 'Branches', text: 'acme/app: feat -> main' },
      { label: 'Title', text: 'Add it' },
      { label: 'Description', text: description },
    ])
    expect(hostWritePreview({ ...card, quote: { author: 'rev', body: 'Why?' } })).toEqual({
      long: false, sections: [{ label: 'rev wrote', text: 'Why?' }, { label: 'Comment', text: 'Log it.' }],
    })
  })

  it('is null when the payload lacks what the approval would post', () => {
    expect(hostWritePreview({ ...card, replyText: undefined })).toBeNull()
    expect(hostWritePreview({ ...card, action: 'review' })).toBeNull()
    expect(hostWritePreview({ ...card, action: 'create' })).toBeNull()
    expect(hostWritePreview({ ...card, action: 'merge' as never })).toBeNull()
  })
})

describe('approvalChoiceOnly', () => {
  it('keeps the choice and drops replacement content', () => {
    expect(approvalChoiceOnly({
      text: 't', resolve: true, verdict: 'approve', summary: 's', comments: [{ id: 'c1', text: 'x' }], title: 'T', description: 'D',
    })).toEqual({ resolve: true, verdict: 'approve' })
    expect(approvalChoiceOnly({ text: 't' })).toEqual({})
  })
})
