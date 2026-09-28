import { describe, expect, it } from 'vitest'
import { approvalActions } from '../../apps/mobile/src/lib/approval-actions'
import { approvalChoiceOnly, HOST_WRITE_PHONE_APPROVAL_CAPABILITY, hostWritePreview, hostWriteShownDigest } from '../../src/shared/host-write-phone'
import { BACKEND_CAPABILITIES } from '../../src/shared/ws-protocol'
import type { HostWriteCard } from '../../src/shared/agent-host-writes'
import type { FeedItem } from '../../apps/mobile/src/stores/chat'

type Approval = Extract<FeedItem, { kind: 'approval' }>

const card: HostWriteCard = {
  action: 'comment', agentLabel: 'Codex', host: 'github', prLabel: 'app #1', target: { repository: 'acme/app', number: 1 }, url: null,
  location: 'a.ts:3', quote: null, replyText: 'Log it.', maxChars: 8000,
}
const item = (over: Partial<Approval> = {}): Approval => ({
  kind: 'approval', id: 'a-1', requestId: 'sbmcp_1', toolName: 'x', detail: 'd', requestType: 'tool', state: 'pending', ...over,
})

describe('approvalActions', () => {
  it('approves a pull request write only on a backend that takes a phone approval', () => {
    expect(approvalActions(item({ hostWrite: card }), true)).toMatchObject({
      kind: 'host-write', buttons: [{ label: 'Post comment', primary: true, response: { shown: hostWriteShownDigest('sbmcp_1', card) } }],
    })
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

describe('hostWriteShownDigest', () => {
  // Cross-implementation vectors: the same two cards and digests are pinned in
  // the Android HostWriteCardsTest, so the TS and Kotlin ports cannot drift.
  // The values were also computed independently (FNV-1a 64 over UTF-16LE).
  const reply: HostWriteCard = {
    action: 'reply', agentLabel: 'Codex', host: 'github', prLabel: 'app #612', target: { repository: 'acme/app', number: 612 },
    url: null, location: 'a.ts:3', quote: { author: 'rév', body: 'Why? 🙂' }, replyText: 'Because.\nSee a.ts.', maxChars: 8000,
  }
  const create: HostWriteCard = {
    action: 'create', agentLabel: 'Codex', host: 'bitbucket', prLabel: 'acme/app', target: { repository: 'acme/app', number: null },
    url: null, location: null, quote: null, maxChars: 8000,
    create: { repoLabel: 'acme/app', sourceBranch: 'feat/x', targetBranch: 'main', title: 'Add it', description: 'Line one.\nLine two.', draft: false },
  }

  it('matches the pinned cross-implementation vectors', () => {
    expect(hostWriteShownDigest('sbmcp_42', reply)).toBe('d3cf5b181c2a5b68')
    expect(hostWriteShownDigest('sbmcp_43', create)).toBe('fa05a2aef032d27a')
  })

  it('does not match the same text on another card, pull request, repository, host or branch', () => {
    const base = hostWriteShownDigest('sbmcp_42', reply)
    expect(hostWriteShownDigest('sbmcp_99', reply)).not.toBe(base)
    expect(hostWriteShownDigest('sbmcp_42', { ...reply, target: { repository: 'acme/app', number: 613 } })).not.toBe(base)
    expect(hostWriteShownDigest('sbmcp_42', { ...reply, target: { repository: 'acme/other', number: 612 } })).not.toBe(base)
    expect(hostWriteShownDigest('sbmcp_42', { ...reply, host: 'bitbucket' })).not.toBe(base)
    const created = hostWriteShownDigest('sbmcp_43', create)
    expect(hostWriteShownDigest('sbmcp_43', { ...create, create: { ...create.create!, targetBranch: 'develop' } })).not.toBe(created)
  })

  it('changes with what the preview shows and nothing else', () => {
    const base = hostWriteShownDigest('sbmcp_42', reply)
    expect(hostWriteShownDigest('sbmcp_42', { ...reply, replyText: 'Because.\nSee b.ts.' })).not.toBe(base)
    expect(hostWriteShownDigest('sbmcp_42', { ...reply, agentLabel: 'Claude Code', maxChars: 10, prLabel: 'renamed' })).toBe(base)
  })

  it('is null without a preview or a target', () => {
    expect(hostWriteShownDigest('sbmcp_42', { ...reply, replyText: undefined })).toBeNull()
    expect(hostWriteShownDigest('sbmcp_42', { ...reply, target: undefined } as unknown as HostWriteCard)).toBeNull()
  })
})

describe('approvalChoiceOnly', () => {
  it('keeps the choice and drops replacement content', () => {
    expect(approvalChoiceOnly({
      text: 't', resolve: true, verdict: 'approve', summary: 's', comments: [{ id: 'c1', text: 'x' }], title: 'T', description: 'D', shown: 'abc',
    })).toEqual({ resolve: true, verdict: 'approve', shown: 'abc' })
    expect(approvalChoiceOnly({ text: 't' })).toEqual({})
  })
})
