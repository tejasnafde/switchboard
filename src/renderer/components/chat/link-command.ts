/**
 * `/link <session> [messages] [time]` and `/unlink [session]` - parsing and
 * target resolution. Resolution is `/send-to`'s (`resolveSendToTarget`), so a
 * typo or an ambiguous name fails the same way in all three commands.
 *
 * A time needs its unit (`90m`, `4h`): a bare trailing number is the message
 * budget, so plain minutes would be ambiguous.
 */
import { parsePeerLinkDuration, peerLinkBudgetProblem, peerLinkWindowProblem } from '@shared/peer-links'
import { resolveSendToTarget, type SendToSession, type SendToTarget } from './send-to-command'

export const LINK_USAGE =
  'Use /link <session> [messages] [time], for example /link Worker A 50 4h, to let this chat and another one message each other.'

/** One way to read the text after `/link`: a target, and the options the words after it would be. */
export interface LinkSplit {
  target: string
  messages?: number
  windowMs?: number
  /** The option words as typed, kept when the target is pinned. */
  tail: string
}

export type LinkCommand =
  | {
      ok: true
      kind: 'link'
      /** Everything after `/link`. */
      target: string
      /**
       * Readings with trailing options peeled off, fewest peeled first: `[time]`,
       * then `[messages] [time]` or `[messages]`. Empty when nothing trails.
       */
      splits: LinkSplit[]
    }
  /** No target means every link of this chat. */
  | { ok: true; kind: 'unlink'; target: string | null }
  | { ok: false; error: string }

/** Null when the body is not a `/link` or `/unlink` command at all. */
export function parseLinkCommand(body: string): LinkCommand | null {
  const match = /^\/(link|unlink)\b\s*(.*)$/s.exec(body.trim())
  if (!match) return null
  const target = match[2].trim()
  if (match[1] === 'unlink') return { ok: true, kind: 'unlink', target: target || null }
  if (!target) return { ok: false, error: `Name a session. ${LINK_USAGE}` }
  const splits: LinkSplit[] = []
  let rest = target
  let windowMs: number | undefined
  const timed = /^(.*\S)\s+(\S+)$/s.exec(rest)
  if (timed) {
    const ms = parsePeerLinkDuration(timed[2])
    if (ms !== null) {
      windowMs = ms
      rest = timed[1]
      splits.push({ target: rest, windowMs, tail: timed[2] })
    }
  }
  const counted = /^(.*\S)\s+(\d+)$/s.exec(rest)
  if (counted) {
    const tail = windowMs === undefined ? counted[2] : `${counted[2]} ${splits[0].tail}`
    splits.push({
      target: counted[1],
      messages: Number(counted[2]),
      ...(windowMs !== undefined ? { windowMs } : {}),
      tail,
    })
  }
  return { ok: true, kind: 'link', target, splits }
}

export type LinkTarget =
  | (SendToTarget & { ok: true; messages?: number; windowMs?: number })
  | { ok: false; error: string }

/**
 * The session a `/link` names and the budget and time it asks for.
 *
 * Trailing options are peeled off only as far as needed: when the whole text,
 * or the text with only the time peeled, is exactly a chat's title, the rest
 * is part of the name. "Issue 172" stays a chat called "Issue 172", "Issue 172
 * 4h" links it for 4 hours, and "Issue 172 50 4h" with 50 messages.
 */
export function resolveLinkTarget(
  command: Extract<LinkCommand, { kind: 'link' }>,
  sessions: ReadonlyArray<SendToSession>,
  fromSessionId: string,
): LinkTarget {
  const readings: LinkSplit[] = [{ target: command.target, tail: '' }, ...command.splits]
  const exact = readings.find((reading) => {
    const hit = resolveSendToTarget(reading.target, sessions, fromSessionId)
    return hit.ok && hit.title.toLowerCase() === reading.target.toLowerCase()
  })
  const reading = exact ?? readings[readings.length - 1]
  if (reading.messages !== undefined) {
    const problem = peerLinkBudgetProblem(reading.messages)
    if (problem) return { ok: false, error: problem }
  }
  if (reading.windowMs !== undefined) {
    const problem = peerLinkWindowProblem(reading.windowMs)
    if (problem) return { ok: false, error: problem }
  }
  const target = resolveSendToTarget(reading.target, sessions, fromSessionId)
  if (!target.ok) return target
  return {
    ...target,
    ...(reading.messages !== undefined ? { messages: reading.messages } : {}),
    ...(reading.windowMs !== undefined ? { windowMs: reading.windowMs } : {}),
  }
}

/**
 * Swap a picked title for the picked chat's `#<id>` at send time, keeping any
 * budget and time after it, while the command still names that title. Same
 * reason as `pinSendToTarget`: a rename or a new twin before the send must not
 * move it.
 */
export function pinLinkTarget(body: string, pick: { id: string; title: string } | null): string {
  const parsed = parseLinkCommand(body)
  if (!pick || !parsed?.ok || parsed.kind !== 'link') return body
  if (parsed.target === pick.title) return `/link #${pick.id}`
  const split = parsed.splits.find((s) => s.target === pick.title)
  return split ? `/link #${pick.id} ${split.tail}` : body
}
