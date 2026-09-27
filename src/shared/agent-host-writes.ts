/**
 * Pull request writes an AGENT asks for through the Switchboard MCP server
 * (reply to a review conversation, resolve one, re-run a failed check), and
 * the approval card each one shows before anything reaches a host.
 *
 * The card rides the ordinary `request.opened` / `request.closed` events with
 * a `hostWrite` payload, so a client that does not know the payload still
 * renders a plain approval from `detail`. The answer comes back on
 * `provider:respond-to-request` with an optional `HostWriteResponse`: the
 * text the user edited in the card is the text that gets posted.
 */
import type { PrHost } from './pull-requests'
import type { RuntimeMode } from './provider-events'

/** The last line of everything an agent posts, so a reader knows a person did not type it. */
export const VIA_SWITCHBOARD_MARKER = 'via Switchboard'

/** An agent reply is a short answer to a reviewer, not a report. The host's own cap is far higher. */
export const AGENT_REPLY_MAX_CHARS = 8_000

/** Writes one chat may ask for inside the window, approved or not. */
export const AGENT_WRITE_BUDGET = 10
export const AGENT_WRITE_WINDOW_MS = 10 * 60_000

/**
 * How long a card waits for an answer. An unanswered card is denied after
 * this, so an agent that timed out on its side can never post later.
 */
export const HOST_WRITE_APPROVAL_TTL_MS = 10 * 60_000

export type HostWriteAction = 'reply' | 'resolve' | 'rerun'

export interface HostWriteCard {
  action: HostWriteAction
  /** "Codex", "Claude Code", "OpenCode": who asked. */
  agentLabel: string
  host: PrHost
  /** "ssg-bot-v2 #612". */
  prLabel: string
  url: string | null
  /** "sync/worker.py:88", or null for a conversation on the whole PR. */
  location: string | null
  /** The reviewer comment the reply answers, or the conversation being resolved. */
  quote: { author: string; body: string } | null
  /** The agent's draft; the card lets the user edit it. Reply only. */
  replyText?: string
  /** The agent asked to resolve after replying, so "Post and resolve" is the primary button. */
  suggestResolve?: boolean
  /** Re-run only. */
  checkName?: string
  maxChars: number
}

/** What the card sends back with an approval. */
export interface HostWriteResponse {
  /** The reply as the user left it in the card. */
  text?: string
  /** "Post and resolve" (true) or "Post only" (false). Absent from a client that shows a plain approval, which runs what the agent asked. */
  resolve?: boolean
}

export type AgentToolGate = 'allow' | 'deny' | 'card'

/**
 * Posting as the user on GitHub or Bitbucket is not a local edit, so full
 * access does not waive the card: it is the one place a person sees the words
 * before they go out under their name. Plan mode refuses without a card,
 * because nothing enforces plan mode for an MCP tool except this server.
 */
export function hostWriteGate(mode: RuntimeMode): AgentToolGate {
  return mode === 'plan' ? 'deny' : 'card'
}

/** `text` with exactly one marker line at the end, whatever the agent or the user already typed. */
export function withViaMarker(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim().replace(/^[_*]+|[_*]+$/g, '').toLowerCase() === VIA_SWITCHBOARD_MARKER.toLowerCase()) {
    lines.pop()
  }
  const body = lines.join('\n').replace(/\s+$/, '')
  return body ? `${body}\n\n${VIA_SWITCHBOARD_MARKER}` : VIA_SWITCHBOARD_MARKER
}

export type ReplyTextCheck = { ok: true; text: string } | { ok: false; message: string }

/** The same rule for the agent's draft and the user's edit. Trims; the marker is added later. */
export function checkReplyText(value: unknown): ReplyTextCheck {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, message: 'The reply is empty.' }
  const text = value.trim()
  if (text.length > AGENT_REPLY_MAX_CHARS) {
    return { ok: false, message: `The reply is ${text.length} characters; the limit is ${AGENT_REPLY_MAX_CHARS}. Say it shorter.` }
  }
  return { ok: true, text }
}

/** The approval as plain text, for a client that does not render the card (an older phone). */
export function hostWriteDetail(card: HostWriteCard): string {
  const where = [card.prLabel, card.location].filter(Boolean).join(' · ')
  const lines: string[] = []
  if (card.action === 'reply') lines.push(`Reply on ${where}${card.suggestResolve ? ', then resolve' : ''}`)
  if (card.action === 'resolve') lines.push(`Resolve the conversation on ${where}`)
  if (card.action === 'rerun') lines.push(`Re-run ${card.checkName ?? 'a failed check'} on ${card.prLabel}`)
  if (card.quote) lines.push('', `${card.quote.author}: ${card.quote.body}`)
  if (card.replyText) lines.push('', card.replyText)
  lines.push('', 'Answer this on the desktop: a phone cannot post to a pull request.')
  return lines.join('\n')
}

export function hostWriteTitle(card: HostWriteCard): string {
  if (card.action === 'reply') return card.suggestResolve ? 'Reply and resolve a review conversation' : 'Reply to a review conversation'
  if (card.action === 'resolve') return 'Resolve a review conversation'
  return 'Re-run a failed check'
}

/** Only what the card may carry back; anything else a client sends is dropped. */
export function parseHostWriteResponse(value: unknown): HostWriteResponse {
  if (!value || typeof value !== 'object') return {}
  const r = value as Record<string, unknown>
  return {
    ...(typeof r.text === 'string' ? { text: r.text } : {}),
    ...(typeof r.resolve === 'boolean' ? { resolve: r.resolve } : {}),
  }
}
