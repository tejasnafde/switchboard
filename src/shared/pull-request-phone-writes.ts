/**
 * Pull request writes from a phone: reply, resolve, a comment on the whole
 * pull request, and a review (comment, approve, request changes) with no line
 * comments. Merge, close, decline, reviewers and re-run stay on the desktop.
 *
 * A phone needs the `pr-write` device scope, which only the desktop grants
 * (`mobile-pairing:set-pr-write`). Each write carries a `PhonePrWriteProof`:
 * the digest of what the phone's confirm sheet showed (account, pull request,
 * thread, action, exact text) and a one-time write id. The backend recomputes
 * the digest from the request and the account it posts as, refuses a missing
 * or different one, and refuses a write id it has seen, so a write is never
 * sent twice. Pure, so the Expo app and the tests share one rule set; Android
 * ports it (`PhonePrWrites.kt`), with the digest vectors pinned in both suites.
 */
import { fnv1a64Hex } from './fnv64'
import { PullRequestWriteChannels } from './ipc-channels'
import type { PrHost, PrRef } from './pull-requests'
import { PR_TEXT_MAX_CHARS, type ReviewEvent } from './pull-request-writes'

/** The backend takes phone writes with a proof, and grants `pr-write` from the desktop. */
export const PR_WRITE_SCOPE_CAPABILITY = 'pr_write_scope_v1'

export type PhonePrWriteAction = 'reply' | 'resolve' | 'comment' | 'review'

/** The write channels a `pr-write` device may call. Every other write channel stays `admin`. */
export const PHONE_PR_WRITE_CHANNELS: Readonly<Record<PhonePrWriteAction, string>> = {
  reply: PullRequestWriteChannels.REPLY,
  resolve: PullRequestWriteChannels.RESOLVE,
  comment: PullRequestWriteChannels.COMMENT,
  review: PullRequestWriteChannels.SUBMIT_REVIEW,
}

export function phonePrWriteActionFor(channel: string): PhonePrWriteAction | null {
  const found = (Object.entries(PHONE_PR_WRITE_CHANNELS) as Array<[PhonePrWriteAction, string]>).find(
    ([, ch]) => ch === channel,
  )
  return found ? found[0] : null
}

/** Sent as `phone` inside the write's input object. */
export interface PhonePrWriteProof {
  /** `phonePrWriteDigest` of the sheet the user confirmed. */
  shown: string
  /** Random, minted when the user taps Post. The backend accepts each one once. */
  writeId: string
}

/** Everything the confirm sheet shows, and so everything the digest binds. */
export interface PhonePrWriteSheet {
  /** The account the backend posts as (`PullRequestPhoneChannels.WRITE_ACCOUNT`). */
  account: string
  ref: PrRef
  action: PhonePrWriteAction
  /** The thread a reply or resolve targets; null for a comment or review. */
  conversationId: string | null
  /** The verdict of a review; null otherwise. */
  event: ReviewEvent | null
  /** The exact text sent: the reply, comment or review summary. Empty for resolve. */
  text: string
  writeId: string
}

const DIGEST_VERSION = 'sb-pr-write-1'

/** FNV-1a 64 over the sheet's fields joined by NUL, as in `hostWriteShownDigest`. */
export function phonePrWriteDigest(sheet: PhonePrWriteSheet): string {
  return fnv1a64Hex(
    [
      DIGEST_VERSION,
      sheet.writeId,
      sheet.ref.host,
      sheet.ref.owner,
      sheet.ref.name,
      String(sheet.ref.number),
      sheet.action,
      sheet.conversationId ?? '',
      sheet.event ?? '',
      sheet.account,
      sheet.text,
    ].join('\u0000'),
  )
}

const WRITE_ID = /^[A-Za-z0-9_-]{16,64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The proof inside a write's input, or null when it is missing or malformed. */
export function readPhoneProof(input: unknown): PhonePrWriteProof | null {
  if (!isRecord(input) || !isRecord(input.phone)) return null
  const { shown, writeId } = input.phone
  if (typeof shown !== 'string' || !/^[0-9a-f]{16}$/.test(shown)) return null
  if (typeof writeId !== 'string' || !WRITE_ID.test(writeId)) return null
  return { shown, writeId }
}

/**
 * The sheet a write's raw input describes, without the account, or a refusal.
 * The text is the raw string the phone sent, before the service trims it, so
 * both sides digest the same characters.
 */
export function phoneSheetFromInput(
  ref: PrRef,
  action: PhonePrWriteAction,
  input: unknown,
  writeId: string,
): Omit<PhonePrWriteSheet, 'account'> | { problem: string } {
  if (!isRecord(input)) return { problem: 'The write is missing.' }
  const conversationId = action === 'reply' || action === 'resolve' ? input.conversationId : null
  if (conversationId !== null && typeof conversationId !== 'string') return { problem: 'The thread is missing.' }
  let text = ''
  if (action !== 'resolve') {
    if (typeof input.body !== 'string') return { problem: 'The text is missing.' }
    text = input.body
  }
  let event: ReviewEvent | null = null
  if (action === 'review') {
    if (input.event !== 'comment' && input.event !== 'approve' && input.event !== 'request_changes')
      return { problem: 'Not a review verdict.' }
    event = input.event
    // The phone shows no diff, so a line comment from it was not seen.
    if (!Array.isArray(input.comments) || input.comments.length > 0)
      return { problem: 'Comment on lines from the desktop.' }
  }
  return { ref, action, conversationId, event, text, writeId }
}

// ─── Copy ─────────────────────────────────────────────────────────

/**
 * The note under a phone composer once the text passes the limit, named for
 * the host: GitHub caps a comment at 65,536 characters, and Bitbucket sets
 * its own limit. Switchboard stops at `PR_TEXT_MAX_CHARS` on both. Null while
 * the text fits.
 */
export function prTextLimitNote(host: PrHost, length: number): string | null {
  if (length <= PR_TEXT_MAX_CHARS) return null
  const max = PR_TEXT_MAX_CHARS.toLocaleString('en-US')
  const over = (length - PR_TEXT_MAX_CHARS).toLocaleString('en-US')
  return host === 'github'
    ? `GitHub takes at most 65,536 characters. Switchboard stops at ${max}. Remove ${over}.`
    : `Bitbucket sets its own limit. Switchboard stops at ${max}. Remove ${over}.`
}

export const PHONE_PR_WRITE_COPY = {
  /** Where write buttons would be, on a phone without the scope. */
  noScope: 'Ask the desktop to allow pull request writes.',
  /** A phone with no passcode, fingerprint or face unlock cannot use the scope. */
  noPasscode: 'Set a passcode on this phone to post from it.',
  /** The write failed in a way that may have reached the host. */
  notSureTitle: 'Not sure it posted',
  notSureBody:
    'The connection dropped before the computer answered. Switchboard does not send it again. Check the thread first.',
  /** The desktop removed the scope while the sheet was open. */
  removed: 'The desktop removed pull request writes for this phone. Your text is kept.',
  approveNote: 'Approving does not merge.',
} as const

/** The refusal for a write id the backend has already taken. */
export const PHONE_PR_WRITE_DUPLICATE =
  'This write was already sent once. Switchboard does not send it again. Check the thread.'
/** The refusal for a proof that is missing or does not match. */
export const PHONE_PR_WRITE_MISMATCH =
  'What this phone showed does not match what would be posted. Open the pull request again and retry.'
