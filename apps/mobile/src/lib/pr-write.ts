/**
 * Phone pull request writes (`@shared/pull-request-phone-writes`): what a
 * write target is, what its composer allows, what the confirm sheet names its
 * button, how a write request is built, and how a failed send is read. Pure
 * apart from `newWriteId`, so the sheet and its tests share one rule set.
 *
 * Rules that live here and nowhere else in the app: the text sent is the text
 * shown (trimmed once, before the sheet shows it), every Post mints a new
 * write id, and nothing is ever re-sent.
 */
import { phonePrWriteDigest, PHONE_PR_WRITE_CHANNELS, type PhonePrWriteAction } from '@shared/pull-request-phone-writes'
import {
  PR_TEXT_MAX_CHARS,
  REVIEW_EVENT_LABEL,
  reviewEventsFor,
  reviewSubmitProblem,
  type ReviewEvent,
} from '@shared/pull-request-writes'
import type { PrConversation, PrHost, PrRef, PrSummary } from '@shared/pull-requests'

/** What the user is writing: a thread reply or resolve, or a comment or review on the whole pull request. */
export type PrWriteTarget =
  | { action: 'reply'; conversation: PrConversation }
  | { action: 'resolve'; conversation: PrConversation }
  | { action: 'comment' }
  | { action: 'review' }

/** Drafts are kept per target, so a reply to one thread never shows under another. */
export function draftKey(target: PrWriteTarget): string {
  return target.action === 'reply' || target.action === 'resolve'
    ? `${target.action}:${target.conversation.id}`
    : target.action
}

/** "path:line", "path:start-end", the file alone, or "General" for the whole pull request. */
export function threadLocation(c: Pick<PrConversation, 'path' | 'line' | 'startLine'>): string {
  if (!c.path) return 'General'
  if (c.line === null) return c.path
  return c.startLine !== undefined && c.startLine !== c.line
    ? `${c.path}:${c.startLine}-${c.line}`
    : `${c.path}:${c.line}`
}

/** The verdicts the phone offers: never your own approval, and approve or request changes only while open. */
export function phoneReviewEvents(pr: Pick<PrSummary, 'viewer' | 'state'>): ReviewEvent[] {
  return reviewEventsFor(pr.viewer).filter((event) => event === 'comment' || pr.state === 'open')
}

/**
 * Why the text cannot go yet, or null. Empty and over-limit are both a
 * reason; the limit note itself comes from `prTextLimitNote`.
 */
export function composeProblem(
  host: PrHost,
  action: PhonePrWriteAction,
  event: ReviewEvent | null,
  text: string,
): string | null {
  const trimmed = text.trim()
  if (action === 'resolve') return null
  if (trimmed.length > PR_TEXT_MAX_CHARS) return 'The text is too long.'
  if (action === 'review') return reviewSubmitProblem(host, event ?? 'comment', trimmed, 0)
  return trimmed ? null : 'Write something first.'
}

/** The confirm sheet's primary button. */
export function postLabel(action: PhonePrWriteAction, event: ReviewEvent | null): string {
  if (action === 'reply') return 'Post reply'
  if (action === 'resolve') return 'Resolve'
  if (action === 'comment') return 'Post comment'
  return REVIEW_EVENT_LABEL[event ?? 'comment']
}

/** The sheet's title, a question about what Post does. */
export function sheetTitle(action: PhonePrWriteAction, event: ReviewEvent | null): string {
  if (action === 'reply') return 'Post this reply?'
  if (action === 'resolve') return 'Resolve this thread?'
  if (action === 'comment') return 'Post this comment?'
  if (event === 'approve') return 'Approve pull request?'
  if (event === 'request_changes') return 'Request changes?'
  return 'Post this review?'
}

/** The short note on the screen after a write the host took. */
export function postedNote(action: PhonePrWriteAction, event: ReviewEvent | null): string {
  if (action === 'resolve') return 'Resolved'
  if (action === 'review' && event === 'approve') return 'Approved'
  if (action === 'review' && event === 'request_changes') return 'Changes requested'
  return 'Posted'
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** 'w_' plus 24 base64url characters from 18 random bytes: 26 characters, inside the backend's 16..64. */
export function writeIdFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 18) throw new Error('a write id needs 18 random bytes')
  let out = 'w_'
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += BASE64URL[(n >> 18) & 63] + BASE64URL[(n >> 12) & 63] + BASE64URL[(n >> 6) & 63] + BASE64URL[n & 63]
  }
  return out
}

/** A fresh write id for one Post tap. */
export function newWriteId(): string {
  // Required lazily, so a test of the pure rules above never loads the native module.
  const Crypto = require('expo-crypto') as typeof import('expo-crypto')
  return writeIdFromBytes(Crypto.getRandomBytes(18))
}

export interface PrWriteRequest {
  channel: string
  input: Record<string, unknown>
}

/**
 * The channel and input for one Post. `text` is the trimmed string the sheet
 * showed; it is both the body sent and the text the digest binds.
 */
export function buildWriteRequest(args: {
  account: string
  ref: PrRef
  target: PrWriteTarget
  event: ReviewEvent | null
  text: string
  writeId: string
}): PrWriteRequest {
  const { account, ref, target, writeId } = args
  const action = target.action
  const conversationId = action === 'reply' || action === 'resolve' ? target.conversation.id : null
  const event = action === 'review' ? (args.event ?? 'comment') : null
  const text = action === 'resolve' ? '' : args.text
  const phone = {
    shown: phonePrWriteDigest({ account, ref, action, conversationId, event, text, writeId }),
    writeId,
  }
  const channel = PHONE_PR_WRITE_CHANNELS[action]
  if (action === 'reply') return { channel, input: { conversationId, body: text, phone } }
  if (action === 'resolve') return { channel, input: { conversationId, phone } }
  if (action === 'comment') return { channel, input: { body: text, phone } }
  return { channel, input: { event, body: text, comments: [], phone } }
}

/**
 * A rejected send (the promise threw, not a `{ ok: false }` answer). 'not
 * permitted' is the backend refusing the channel: the desktop removed the
 * scope, so nothing was posted. Anything else (a timeout, a dropped socket)
 * may have reached the host, so the phone says it is not sure and never
 * sends again.
 */
export function classifyRejectedWrite(err: unknown): 'removed' | 'uncertain' {
  const message = err instanceof Error ? err.message : String(err)
  return message.startsWith('not permitted') ? 'removed' : 'uncertain'
}
