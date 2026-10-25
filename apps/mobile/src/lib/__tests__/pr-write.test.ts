/**
 * The phone's write rules: the request carries the digest of exactly the
 * text it sends (pinned to the vectors Android ports), write ids fit the
 * backend's format, and a rejected send is read as removed or not sure.
 */
import { phonePrWriteDigest } from '@shared/pull-request-phone-writes'
import type { PrConversation, PrRef } from '@shared/pull-requests'
import {
  buildWriteRequest,
  classifyRejectedWrite,
  composeProblem,
  phoneReviewEvents,
  threadLocation,
  writeIdFromBytes,
} from '../pr-write'

const ref: PrRef = { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 161 }
const thread: PrConversation = {
  id: 'PRRT_1',
  path: 'src/a.ts',
  line: 88,
  side: 'new',
  resolved: false,
  outdated: false,
  comments: [],
}

describe('buildWriteRequest', () => {
  it('sends the reply text and the pinned digest of that text', () => {
    const request = buildWriteRequest({
      account: 'tejasnafde',
      ref,
      target: { action: 'reply', conversation: thread },
      event: null,
      text: 'Fixed in the next commit.',
      writeId: 'w_0123456789abcdef',
    })
    expect(request).toEqual({
      channel: 'pull-requests:reply',
      input: {
        conversationId: 'PRRT_1',
        body: 'Fixed in the next commit.',
        phone: { shown: '80257400afe1485a', writeId: 'w_0123456789abcdef' },
      },
    })
  })

  it('matches the pinned review vector', () => {
    const request = buildWriteRequest({
      account: 'Jane Doe (jdoe)',
      ref: { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2', number: 612 },
      target: { action: 'review' },
      event: 'approve',
      text: 'Looks good. ✓ naïve',
      writeId: 'w_0123456789abcdef',
    })
    expect(request.channel).toBe('pull-requests:submit-review')
    expect(request.input).toEqual({
      event: 'approve',
      body: 'Looks good. ✓ naïve',
      comments: [],
      phone: { shown: '41ea42c76939646c', writeId: 'w_0123456789abcdef' },
    })
  })

  it('digests an empty text for resolve and sends no body', () => {
    const request = buildWriteRequest({
      account: 'tejasnafde',
      ref,
      target: { action: 'resolve', conversation: thread },
      event: null,
      text: 'ignored',
      writeId: 'w_0123456789abcdef',
    })
    expect(request.input).toEqual({
      conversationId: 'PRRT_1',
      phone: {
        shown: phonePrWriteDigest({
          account: 'tejasnafde',
          ref,
          action: 'resolve',
          conversationId: 'PRRT_1',
          event: null,
          text: '',
          writeId: 'w_0123456789abcdef',
        }),
        writeId: 'w_0123456789abcdef',
      },
    })
  })
})

describe('write ids', () => {
  it('are w_ plus 24 base64url characters', () => {
    const id = writeIdFromBytes(new Uint8Array(18).map((_, i) => i * 14 + 3))
    expect(id).toMatch(/^w_[A-Za-z0-9_-]{24}$/)
    expect(writeIdFromBytes(new Uint8Array(18).fill(255))).toBe(`w_${'_'.repeat(24)}`)
  })
})

describe('classifyRejectedWrite', () => {
  it('reads not permitted as the scope removed and anything else as not sure', () => {
    expect(classifyRejectedWrite(new Error('not permitted: pull-requests:reply'))).toBe('removed')
    expect(classifyRejectedWrite(new Error('request timed out'))).toBe('uncertain')
    expect(classifyRejectedWrite('socket closed')).toBe('uncertain')
  })
})

describe('composer rules', () => {
  it('refuses empty or over-limit text, and a change request without a summary', () => {
    expect(composeProblem('github', 'reply', null, '   ')).not.toBeNull()
    expect(composeProblem('github', 'reply', null, 'x'.repeat(60_001))).not.toBeNull()
    expect(composeProblem('github', 'reply', null, ' ok ')).toBeNull()
    expect(composeProblem('github', 'resolve', null, '')).toBeNull()
    expect(composeProblem('github', 'review', 'approve', '')).toBeNull()
    expect(composeProblem('github', 'review', 'request_changes', '')).toBe('GitHub needs a summary to request changes.')
  })

  it('offers the author Comment only, and a closed pull request no verdict', () => {
    const viewer = { isAuthor: false, isRequestedReviewer: true, hasReviewed: false, hasCommented: false }
    expect(phoneReviewEvents({ viewer, state: 'open' })).toEqual(['comment', 'approve', 'request_changes'])
    expect(phoneReviewEvents({ viewer: { ...viewer, isAuthor: true }, state: 'open' })).toEqual(['comment'])
    expect(phoneReviewEvents({ viewer, state: 'merged' })).toEqual(['comment'])
  })

  it('names a thread by file and line, or General', () => {
    expect(threadLocation(thread)).toBe('src/a.ts:88')
    expect(threadLocation({ ...thread, startLine: 80 })).toBe('src/a.ts:80-88')
    expect(threadLocation({ ...thread, line: null })).toBe('src/a.ts')
    expect(threadLocation({ ...thread, path: null })).toBe('General')
  })
})
