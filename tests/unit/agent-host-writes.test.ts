import { describe, expect, it } from 'vitest'
import {
  AGENT_REPLY_MAX_CHARS,
  checkReplyText,
  hostWriteDetail,
  hostWriteTitle,
  createPullRequestGate,
  hostWriteGate,
  parseHostWriteResponse,
  withViaMarker,
  type HostWriteCard,
} from '../../src/shared/agent-host-writes'
import { pushForEvent } from '../../src/shared/push-policy'
import type { RuntimeMode } from '../../src/shared/provider-events'
import { hostWriteApprovalProblem, phoneHostWriteButtons } from '../../src/shared/host-write-phone'
import type { ReviewEvent } from '../../src/shared/pull-request-writes'

const card: HostWriteCard = {
  action: 'reply',
  agentLabel: 'Codex',
  host: 'bitbucket',
  prLabel: 'ssg-bot-v2 #612',
  url: null,
  location: 'sync/worker.py:88',
  quote: { author: 'pankaj', body: 'Cap the jitter too.' },
  replyText: 'Done in a1b2c3d.',
  suggestResolve: true,
  maxChars: AGENT_REPLY_MAX_CHARS,
}

describe('withViaMarker', () => {
  it('ends the text with one marker line', () => {
    expect(withViaMarker('Done in a1b2c3d.')).toBe('Done in a1b2c3d.\n\nvia Switchboard')
  })

  it('does not add a second marker when the text already ends with one', () => {
    expect(withViaMarker('Done.\n\nvia Switchboard')).toBe('Done.\n\nvia Switchboard')
    expect(withViaMarker('Done.\n_via Switchboard_\n')).toBe('Done.\n\nvia Switchboard')
  })

  it('keeps a marker mentioned mid-text', () => {
    expect(withViaMarker('Posted via Switchboard earlier.')).toBe('Posted via Switchboard earlier.\n\nvia Switchboard')
  })
})

describe('checkReplyText', () => {
  it('trims and accepts ordinary text', () => {
    expect(checkReplyText('  fixed  ')).toEqual({ ok: true, text: 'fixed' })
  })

  it('refuses empty, non-string and oversized text', () => {
    expect(checkReplyText('   ').ok).toBe(false)
    expect(checkReplyText(42).ok).toBe(false)
    const long = checkReplyText('x'.repeat(AGENT_REPLY_MAX_CHARS + 1))
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.message).toContain(String(AGENT_REPLY_MAX_CHARS))
  })
})

describe('hostWriteGate', () => {
  it('denies in plan mode and asks in every other mode, full access included', () => {
    const modes: RuntimeMode[] = ['sandbox', 'accept-edits', 'auto', 'full-access']
    expect(hostWriteGate('plan')).toBe('deny')
    for (const mode of modes) expect(hostWriteGate(mode)).toBe('card')
  })
})

describe('createPullRequestGate', () => {
  it('opens without a card only in full access, and refuses in plan mode', () => {
    expect(createPullRequestGate('full-access')).toBe('allow')
    expect(createPullRequestGate('plan')).toBe('deny')
    for (const mode of ['sandbox', 'accept-edits', 'auto'] as const) expect(createPullRequestGate(mode)).toBe('card')
  })
})

describe('parseHostWriteResponse', () => {
  it('keeps only the edited text and the resolve choice', () => {
    expect(parseHostWriteResponse({ text: 'edited', resolve: false, merge: true })).toEqual({ text: 'edited', resolve: false })
    expect(parseHostWriteResponse(null)).toEqual({})
    expect(parseHostWriteResponse({ text: 3, resolve: 'yes' })).toEqual({})
  })

  it('keeps a review\'s verdict, summary and kept comments, dropping malformed ones', () => {
    expect(parseHostWriteResponse({
      verdict: 'approve', summary: 'LGTM', comments: [{ id: 'c1', text: 'ok' }, { id: 2, text: 'x' }, null, { id: 'c3' }], merge: true,
    })).toEqual({ verdict: 'approve', summary: 'LGTM', comments: [{ id: 'c1', text: 'ok' }] })
    expect(parseHostWriteResponse({ verdict: 'merge', comments: 'c1' })).toEqual({})
  })
})

describe('hostWriteDetail', () => {
  it('describes the write in plain text, with nothing sending the phone to the desktop', () => {
    const detail = hostWriteDetail(card)
    expect(detail).toContain('Reply on ssg-bot-v2 #612 · sync/worker.py:88, then resolve')
    expect(detail).toContain('pankaj: Cap the jitter too.')
    expect(detail).toContain('Done in a1b2c3d.')
    expect(detail).not.toContain('desktop')
  })
})

describe('hostWriteDetail for the new comment writes', () => {
  it('names a line comment and every comment of a review, cut short', () => {
    expect(hostWriteDetail({ ...card, action: 'comment', suggestResolve: undefined, quote: null, replyText: 'Log it.' })).toContain('Comment on ssg-bot-v2 #612 · sync/worker.py:88')
    const review = hostWriteDetail({
      ...card, action: 'review', location: null, quote: null, replyText: undefined, suggestResolve: undefined,
      review: { summary: 'Two notes.', verdicts: ['comment'], comments: [{ id: 'c1', path: 'a.py', side: 'new', line: 3, text: 'x'.repeat(400), excerpt: [] }] },
    })
    expect(review).toContain('Review ssg-bot-v2 #612 with 1 line comments')
    expect(review).toContain('Two notes.')
    expect(review).toContain(`a.py:3: ${'x'.repeat(300)}…`)
  })
})

describe('a comment on a range of lines', () => {
  it('says which lines in the title, in the plain text and on each review row', () => {
    const comment: HostWriteCard = { ...card, action: 'comment', suggestResolve: undefined, quote: null, replyText: 'Log it.', location: 'sync/worker.py:40-52', lineRange: { start: 40, end: 52 } }
    expect(hostWriteTitle(comment)).toBe('Comment on lines 40-52')
    expect(hostWriteTitle({ ...comment, lineRange: undefined })).toBe('Comment on a line')
    expect(hostWriteDetail(comment)).toContain('Comment on ssg-bot-v2 #612 · sync/worker.py:40-52')
    const review = hostWriteDetail({
      ...card, action: 'review', location: null, quote: null, replyText: undefined, suggestResolve: undefined,
      review: { summary: 's', verdicts: ['comment'], comments: [{ id: 'c1', path: 'a.py', side: 'old', line: 52, startLine: 40, text: 'Why?', excerpt: [] }] },
    })
    expect(review).toContain('a.py:40-52 (old): Why?')
  })
})

describe('push for a host write card', () => {
  it('names the write, without sending the phone to the desktop', () => {
    const push = pushForEvent({ type: 'request.opened', threadId: 't1', requestId: 'sbmcp_1', requestType: 'tool', toolName: 'mcp__switchboard__reply_to_conversation', detail: '', hostWrite: card })
    expect(push?.body).toBe('Needs approval: Reply and resolve a review conversation on ssg-bot-v2 #612')
  })

  it('names a draft review', () => {
    const review: HostWriteCard = { ...card, action: 'review', review: { summary: 's', comments: [], verdicts: ['comment'] } }
    const push = pushForEvent({ type: 'request.opened', threadId: 't1', requestId: 'sbmcp_2', requestType: 'tool', toolName: 'mcp__switchboard__draft_review', detail: '', hostWrite: review })
    expect(push?.body).toBe('Needs approval: Submit a review on ssg-bot-v2 #612')
  })
})

describe('phoneHostWriteButtons', () => {
  const review = (verdicts: ReviewEvent[], summary = 'Two notes.'): HostWriteCard => ({
    ...card, action: 'review', location: null, quote: null, replyText: undefined, suggestResolve: undefined,
    review: { summary, verdicts, comments: [] },
  })

  it('names the action, with the primary button the agent suggested for a reply', () => {
    expect(phoneHostWriteButtons(card).map((b) => [b.label, b.primary, b.response])).toEqual([
      ['Post reply', false, { resolve: false }],
      ['Post and resolve', true, { resolve: true }],
    ])
    expect(phoneHostWriteButtons({ ...card, action: 'comment' }).map((b) => b.label)).toEqual(['Post comment'])
    expect(phoneHostWriteButtons({ ...card, action: 'resolve' }).map((b) => b.label)).toEqual(['Resolve'])
    expect(phoneHostWriteButtons({ ...card, action: 'rerun' }).map((b) => b.label)).toEqual(['Re-run'])
    expect(phoneHostWriteButtons({ ...card, action: 'create', create: { repoLabel: 'a/b', sourceBranch: 'x', targetBranch: 'main', title: 't', description: '', draft: false } })[0])
      .toMatchObject({ label: 'Open pull request', primary: true, response: {} })
  })

  it('offers only the verdicts the card lists, none primary, and says why one cannot go as drafted', () => {
    const buttons = phoneHostWriteButtons(review(['comment', 'approve', 'request_changes'], ''))
    expect(buttons.map((b) => [b.label, b.primary, b.response.verdict])).toEqual([
      ['Comment', false, 'comment'],
      ['Request changes', false, 'request_changes'],
      ['Approve', false, 'approve'],
    ])
    expect(buttons.find((b) => b.id === 'request_changes')?.problem).toBe('Say what should change.')
    expect(buttons.find((b) => b.id === 'approve')?.problem).toBeNull()
    expect(phoneHostWriteButtons(review(['comment'])).map((b) => b.label)).toEqual(['Comment'])
  })
})

describe('hostWriteApprovalProblem', () => {
  const review: HostWriteCard = { ...card, action: 'review', review: { summary: 's', comments: [], verdicts: ['comment'] } }

  it('needs a verdict from the card for a review, and nothing else for the other writes', () => {
    expect(hostWriteApprovalProblem(card, {})).toBeNull()
    expect(hostWriteApprovalProblem(review, {})).toContain('Pick Comment')
    expect(hostWriteApprovalProblem(review, { verdict: 'request_changes' })).toBe('Request changes is not offered on this review.')
    expect(hostWriteApprovalProblem(review, { verdict: 'comment' })).toBeNull()
  })
})
