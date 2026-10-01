/**
 * `/link <session> [messages]` and `/unlink [session]` - parsing and target
 * resolution. Resolution is `/send-to`'s (`resolveSendToTarget`), so a typo or
 * an ambiguous name fails the same way in all three commands.
 */
import { peerLinkBudgetProblem } from '@shared/peer-links'
import { resolveSendToTarget, type SendToSession, type SendToTarget } from './send-to-command'

export const LINK_USAGE = 'Use /link <session> [messages] to let this chat and another one message each other.'

export type LinkCommand =
  | {
    ok: true
    kind: 'link'
    /** Everything after `/link`. */
    target: string
    /** Set when the text ends in a number: the target before it, and the number as a budget. */
    budget?: { target: string; messages: number }
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
  const trailing = /^(.*\S)\s+(\d+)$/s.exec(target)
  return trailing
    ? { ok: true, kind: 'link', target, budget: { target: trailing[1], messages: Number(trailing[2]) } }
    : { ok: true, kind: 'link', target }
}

export type LinkTarget = (SendToTarget & { ok: true; messages?: number }) | { ok: false; error: string }

/**
 * The session a `/link` names and the budget it asks for.
 *
 * A trailing number is a budget, unless the WHOLE text is exactly a chat's
 * title: "Issue 172" stays a chat called "Issue 172", while "Issue 172 50"
 * links it with 50 messages.
 */
export function resolveLinkTarget(
  command: Extract<LinkCommand, { kind: 'link' }>,
  sessions: ReadonlyArray<SendToSession>,
  fromSessionId: string,
): LinkTarget {
  if (!command.budget) return resolveSendToTarget(command.target, sessions, fromSessionId)
  const whole = resolveSendToTarget(command.target, sessions, fromSessionId)
  if (whole.ok && whole.title.toLowerCase() === command.target.toLowerCase()) return whole
  const problem = peerLinkBudgetProblem(command.budget.messages)
  if (problem) return { ok: false, error: problem }
  const split = resolveSendToTarget(command.budget.target, sessions, fromSessionId)
  return split.ok ? { ...split, messages: command.budget.messages } : split
}

/**
 * Swap a picked title for the picked chat's `#<id>` at send time, keeping any
 * budget after it, while the command still names that title. Same reason as
 * `pinSendToTarget`: a rename or a new twin before the send must not move it.
 */
export function pinLinkTarget(body: string, pick: { id: string; title: string } | null): string {
  const parsed = parseLinkCommand(body)
  if (!pick || !parsed?.ok || parsed.kind !== 'link') return body
  if (parsed.target === pick.title) return `/link #${pick.id}`
  if (parsed.budget?.target === pick.title) return `/link #${pick.id} ${parsed.budget.messages}`
  return body
}
