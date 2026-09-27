import { describe, expect, it } from 'vitest'
import { hostWriteButtons, hostWriteContext, hostWriteResponse, replyTextProblem } from '../../src/renderer/components/chat/host-write-card'
import type { HostWriteCard } from '../../src/shared/agent-host-writes'

const reply: HostWriteCard = {
  action: 'reply', agentLabel: 'Codex', host: 'bitbucket', prLabel: 'ssg-bot-v2 #612', url: null,
  location: 'sync/worker.py:88', quote: null, replyText: 'Done.', suggestResolve: true, maxChars: 8000,
}

describe('hostWriteButtons', () => {
  it('offers Deny, Post only and Post and resolve, primary on what the agent suggested', () => {
    expect(hostWriteButtons(reply).map((b) => [b.label, b.primary])).toEqual([['Deny', false], ['Post only', false], ['Post and resolve', true]])
    expect(hostWriteButtons({ ...reply, suggestResolve: false }).find((b) => b.primary)?.label).toBe('Post only')
  })

  it('offers one approval for a resolve and for a re-run', () => {
    expect(hostWriteButtons({ ...reply, action: 'resolve' }).map((b) => b.label)).toEqual(['Deny', 'Resolve'])
    expect(hostWriteButtons({ ...reply, action: 'rerun' }).map((b) => b.label)).toEqual(['Deny', 'Re-run'])
  })
})

describe('hostWriteResponse', () => {
  it('sends the edited text and the resolve choice for a reply', () => {
    expect(hostWriteResponse(reply, 'post', 'edited')).toEqual({ text: 'edited', resolve: false })
    expect(hostWriteResponse(reply, 'post-resolve', 'edited')).toEqual({ text: 'edited', resolve: true })
  })

  it('sends nothing extra for a resolve or a re-run', () => {
    expect(hostWriteResponse({ ...reply, action: 'rerun' }, 'rerun', '')).toEqual({})
  })
})

describe('replyTextProblem', () => {
  it('blocks posting an empty or oversized reply', () => {
    expect(replyTextProblem(reply, 'ok')).toBeNull()
    expect(replyTextProblem(reply, '  ')).not.toBeNull()
    expect(replyTextProblem(reply, 'x'.repeat(8001))).not.toBeNull()
    expect(replyTextProblem({ ...reply, action: 'resolve' }, '')).toBeNull()
  })
})

describe('hostWriteContext', () => {
  it('names the host, the PR and the line', () => {
    expect(hostWriteContext(reply)).toBe('Bitbucket · ssg-bot-v2 #612 · sync/worker.py:88')
  })
})
