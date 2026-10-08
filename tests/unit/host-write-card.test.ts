import { describe, expect, it } from 'vitest'
import {
  hostWriteButtonLabel,
  hostWriteButtons,
  hostWriteContext,
  hostWriteResponse,
  initialCreateDraft,
  initialReviewDraft,
  toggleReviewer,
  replyTextProblem,
  reviewButtonProblem,
} from '../../src/renderer/components/chat/host-write-card'
import type { HostWriteCard } from '../../src/shared/agent-host-writes'

const reply: HostWriteCard = {
  action: 'reply',
  agentLabel: 'Codex',
  host: 'bitbucket',
  prLabel: 'ssg-bot-v2 #612',
  url: null,
  location: 'sync/worker.py:88',
  quote: null,
  replyText: 'Done.',
  suggestResolve: true,
  maxChars: 8000,
}

describe('hostWriteButtons', () => {
  it('offers Deny, Post only and Post and resolve, primary on what the agent suggested', () => {
    expect(hostWriteButtons(reply).map((b) => [b.label, b.primary])).toEqual([
      ['Deny', false],
      ['Post only', false],
      ['Post and resolve', true],
    ])
    expect(hostWriteButtons({ ...reply, suggestResolve: false }).find((b) => b.primary)?.label).toBe('Post only')
  })

  it('offers one approval for a resolve and for a re-run', () => {
    expect(hostWriteButtons({ ...reply, action: 'resolve' }).map((b) => b.label)).toEqual(['Deny', 'Resolve'])
    expect(hostWriteButtons({ ...reply, action: 'rerun' }).map((b) => b.label)).toEqual(['Deny', 'Re-run'])
  })
})

const button = (card: HostWriteCard, id: string) => hostWriteButtons(card).find((b) => b.id === id)!
const noDraft = initialReviewDraft(undefined)

describe('hostWriteResponse', () => {
  it('sends the edited text and the resolve choice for a reply', () => {
    expect(hostWriteResponse(reply, button(reply, 'post'), 'edited', noDraft)).toEqual({
      text: 'edited',
      resolve: false,
    })
    expect(hostWriteResponse(reply, button(reply, 'post-resolve'), 'edited', noDraft)).toEqual({
      text: 'edited',
      resolve: true,
    })
  })

  it('sends nothing extra for a resolve or a re-run', () => {
    const rerun: HostWriteCard = { ...reply, action: 'rerun' }
    expect(hostWriteResponse(rerun, button(rerun, 'rerun'), '', noDraft)).toEqual({})
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

const review: HostWriteCard = {
  action: 'review',
  agentLabel: 'Claude Code',
  host: 'github',
  prLabel: 'switchboard #161',
  url: null,
  location: null,
  quote: null,
  maxChars: 8000,
  review: {
    summary: 'Two notes.',
    comments: [
      { id: 'c1', path: 'a.ts', side: 'new', line: 3, text: 'One.', excerpt: [] },
      { id: 'c2', path: 'b.ts', side: 'old', line: 9, text: 'Two.', excerpt: [] },
    ],
    verdicts: ['comment', 'approve', 'request_changes'],
  },
}

describe('a line comment card', () => {
  it('offers Deny and Post comment, and sends the edited text', () => {
    const comment: HostWriteCard = { ...reply, action: 'comment', suggestResolve: undefined }
    expect(hostWriteButtons(comment).map((b) => [b.label, b.primary])).toEqual([
      ['Deny', false],
      ['Post comment', true],
    ])
    expect(hostWriteResponse(comment, button(comment, 'comment'), 'edited', noDraft)).toEqual({ text: 'edited' })
    expect(replyTextProblem(comment, ' ')).toBe('The comment is empty.')
  })
})

describe('a draft review card', () => {
  it('offers one button per verdict, mildest first, with none of them primary', () => {
    const buttons = hostWriteButtons(review)
    expect(buttons.map((b) => b.label)).toEqual(['Deny', 'Comment', 'Request changes', 'Approve'])
    expect(buttons.some((b) => b.primary)).toBe(false)
  })

  it('offers the author Comment only: no Approve, no Request changes', () => {
    const own: HostWriteCard = {
      ...review,
      review: { ...review.review!, verdicts: ['comment'], commentOnly: 'author' },
    }
    expect(hostWriteButtons(own).map((b) => b.label)).toEqual(['Deny', 'Comment'])
    expect(reviewButtonProblem(own, 'approve', initialReviewDraft(own.review))).toContain('own pull request')
  })

  it('sends the verdict of the button pressed, the summary and only the kept comments as edited', () => {
    const draft = initialReviewDraft(review.review)
    draft.summary = 'Edited summary.'
    draft.comments[0] = { ...draft.comments[0], removed: true }
    draft.comments[1] = { ...draft.comments[1], text: 'Two, edited.' }
    expect(hostWriteResponse(review, button(review, 'approve'), '', draft)).toEqual({
      verdict: 'approve',
      summary: 'Edited summary.',
      comments: [{ id: 'c2', text: 'Two, edited.' }],
    })
    expect(hostWriteResponse(review, button(review, 'request_changes'), '', draft).verdict).toBe('request_changes')
    expect(hostWriteResponse(review, button(review, 'deny'), '', draft)).toEqual({})
  })

  it('blocks a verdict the edited draft cannot carry', () => {
    const draft = initialReviewDraft(review.review)
    expect(reviewButtonProblem(review, 'comment', draft)).toBeNull()
    draft.summary = ''
    expect(reviewButtonProblem(review, 'request_changes', draft)).toContain('GitHub needs a summary')
    expect(reviewButtonProblem(review, 'approve', draft)).toBeNull()
    draft.comments = draft.comments.map((c) => ({ ...c, removed: true }))
    expect(reviewButtonProblem(review, 'comment', draft)).not.toBeNull()
    draft.comments[0] = { ...draft.comments[0], removed: false, text: '' }
    expect(reviewButtonProblem(review, 'comment', draft)).toContain('Comment 1 is empty')
  })
})

describe('a pull request to open', () => {
  const create: HostWriteCard = {
    action: 'create',
    agentLabel: 'Codex',
    host: 'github',
    prLabel: 'acme/app',
    target: { repository: 'acme/app', number: null },
    url: null,
    location: null,
    quote: null,
    maxChars: 16000,
    create: {
      repoLabel: 'acme/app',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      title: 'T',
      description: 'D',
      draft: false,
      reviewers: [
        { id: 'jdoe', login: 'jdoe', displayName: 'Jane Doe', kind: 'user' },
        { id: 'team:platform', login: 'team:platform', displayName: 'Platform', kind: 'team' },
      ],
    },
  }

  it('sends back every reviewer until one is removed, and only the kept ones after', () => {
    const draft = initialCreateDraft(create)
    const open = button(create, 'create')
    expect(hostWriteResponse(create, open, '', noDraft, draft)).toEqual({
      title: 'T',
      description: 'D',
      reviewers: ['jdoe', 'team:platform'],
    })
    const removed = toggleReviewer(draft, 'jdoe')
    expect(hostWriteResponse(create, open, '', noDraft, removed)).toEqual({
      title: 'T',
      description: 'D',
      reviewers: ['team:platform'],
    })
    // Restore brings them back.
    expect(hostWriteResponse(create, open, '', noDraft, toggleReviewer(removed, 'jdoe')).reviewers).toEqual([
      'jdoe',
      'team:platform',
    ])
  })

  it('sends no reviewers field for a card that asked none', () => {
    const plain: HostWriteCard = { ...create, create: { ...create.create!, reviewers: undefined } }
    expect(hostWriteResponse(plain, button(plain, 'create'), '', noDraft, initialCreateDraft(plain))).toEqual({
      title: 'T',
      description: 'D',
    })
  })
})

describe('hostWriteButtonLabel', () => {
  it('says Dismiss and approves quietly when the user chose not to wake the agent', () => {
    const [deny, postOnly] = hostWriteButtons(reply)
    expect(hostWriteButtonLabel(deny, false)).toBe('Deny')
    expect(hostWriteButtonLabel(deny, true)).toBe('Dismiss')
    expect(hostWriteButtonLabel(postOnly, true)).toBe('Post only quietly')
  })
})
