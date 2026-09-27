import { describe, expect, it } from 'vitest'
import {
  AGENT_REPLY_MAX_CHARS,
  checkReplyText,
  hostWriteDetail,
  hostWriteGate,
  parseHostWriteResponse,
  withViaMarker,
  type HostWriteCard,
} from '../../src/shared/agent-host-writes'
import { pushForEvent } from '../../src/shared/push-policy'
import type { RuntimeMode } from '../../src/shared/provider-events'

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
  it('describes the write in plain text and says where to answer', () => {
    const detail = hostWriteDetail(card)
    expect(detail).toContain('Reply on ssg-bot-v2 #612 · sync/worker.py:88, then resolve')
    expect(detail).toContain('pankaj: Cap the jitter too.')
    expect(detail).toContain('Done in a1b2c3d.')
    expect(detail).toContain('desktop')
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
    expect(review).toContain('desktop')
  })
})

describe('push for a host write card', () => {
  it('tells the phone to approve at the desktop', () => {
    const push = pushForEvent({ type: 'request.opened', threadId: 't1', requestId: 'sbmcp_1', requestType: 'tool', toolName: 'mcp__switchboard__reply_to_conversation', detail: '', hostWrite: card })
    expect(push?.body).toBe('Approve at the desktop: Reply and resolve a review conversation on ssg-bot-v2 #612')
  })

  it('names a draft review', () => {
    const review: HostWriteCard = { ...card, action: 'review', review: { summary: 's', comments: [], verdicts: ['comment'] } }
    const push = pushForEvent({ type: 'request.opened', threadId: 't1', requestId: 'sbmcp_2', requestType: 'tool', toolName: 'mcp__switchboard__draft_review', detail: '', hostWrite: review })
    expect(push?.body).toBe('Approve at the desktop: Submit a review on ssg-bot-v2 #612')
  })
})
