/**
 * Approval cards that do not hold the agent's turn.
 *
 * An agent asks for a write through the Switchboard MCP server (a pull request
 * write or a peer message); the tool answers at once that the write is queued
 * for the user, and the card stays open with no time limit, on every client,
 * after the agent's turn ends and across a backend restart. It closes once:
 * approved, approved quietly, denied, dismissed, withdrawn by the agent, or
 * closed because the user stopped or archived the chat. Only an approval runs
 * the write, with every check after the card that ran before.
 *
 * What happened is recorded twice: a system row in the chat for the user
 * (`APPROVAL_RESULT_MARKER_PREFIX`), and, unless the user chose quiet, a turn
 * for the agent (`approvalResultTurn`). That turn is Switchboard's, not the
 * user's: it carries no authority, does not reset peer hop depth and does not
 * renew a session link.
 *
 * Pure, so the lifecycle, the cap and the restart are tested without a
 * backend. `ApprovalCardBook` keeps the open cards and writes through to a
 * store; the backend's store is SQLite (`db/agent-approval-cards.ts`).
 */
import type { HostWriteCard } from './agent-host-writes'
import type { ApprovalDecision } from './provider-events'

/**
 * The backend capability: cards no longer expire and an answer is reported to
 * the agent as a later turn. A phone that knows it stops treating an old card
 * as stale, and offers "Approve quietly" and "Dismiss".
 */
export const AGENT_ASYNC_APPROVAL_CAPABILITY = 'agent_async_approval_v1'

/** Every card the server opens has an id with this prefix; its answer is routed to the server, not the adapter. */
export const AGENT_APPROVAL_ID_PREFIX = 'sbmcp_'

export function isAgentApprovalCardId(requestId: unknown): boolean {
  return typeof requestId === 'string' && requestId.startsWith(AGENT_APPROVAL_ID_PREFIX)
}

/** Open cards one chat may hold. Past it a new ask is refused, so an agent cannot flood the chat. */
export const AGENT_OPEN_CARD_CAP = 20

export const APPROVAL_RESULT_MARKER_PREFIX = '[[sb:approval-result]]'

/** The tag around a result turn. Every surface drops it when it renders a user row (`synthetic-message.ts`). */
export const APPROVAL_RESULT_TAG = 'switchboard-approval-result'

/** How one card closed. `wake` says whether the agent gets a turn about it. */
export type ApprovalCardClose =
  | { kind: 'approve'; wake: boolean }
  | { kind: 'deny'; wake: boolean }
  | { kind: 'withdrawn' }
  | { kind: 'stopped' }

/**
 * The user's answer. A quiet approve runs the write without waking the agent;
 * a quiet deny is a dismiss: nothing is posted and the agent is not told.
 */
export function closeFromAnswer(decision: ApprovalDecision, quiet: boolean): ApprovalCardClose {
  return decision === 'approve' ? { kind: 'approve', wake: !quiet } : { kind: 'deny', wake: !quiet }
}

export function closeWakesAgent(close: ApprovalCardClose): boolean {
  return (close.kind === 'approve' || close.kind === 'deny') && close.wake
}

/** One open card, as stored. `plan` is the write, as data, that an approval runs. */
export interface StoredApprovalCard<Plan = unknown> {
  requestId: string
  /** The root conversation id (`resolveRootThreadId`): links, the budget and the cap key on it. */
  chatId: string
  /** The session id it was opened under, which its events went out on. */
  threadId: string
  toolName: string
  detail: string
  hostWrite: HostWriteCard | null
  plan: Plan
  openedAt: number
}

/** A result the agent has not been told yet because its session was not running. */
export interface HeldApprovalResult {
  id: string
  chatId: string
  body: string
  at: number
}

export interface ApprovalCardStore<Plan = unknown> {
  loadCards(): StoredApprovalCard<Plan>[]
  putCard(card: StoredApprovalCard<Plan>): void
  removeCard(requestId: string): void
  holdResult(result: HeldApprovalResult): void
  /** Every held result of the chat, oldest first, removed from the store. */
  takeHeldResults(chatId: string): HeldApprovalResult[]
}

export function memoryApprovalCardStore<Plan = unknown>(): ApprovalCardStore<Plan> {
  const cards = new Map<string, StoredApprovalCard<Plan>>()
  const held: HeldApprovalResult[] = []
  return {
    loadCards: () => [...cards.values()].map((c) => structuredClone(c)),
    putCard: (card) => {
      cards.set(card.requestId, structuredClone(card))
    },
    removeCard: (id) => {
      cards.delete(id)
    },
    holdResult: (r) => {
      held.push({ ...r })
    },
    takeHeldResults: (chatId) => {
      const mine = held.filter((r) => r.chatId === chatId).sort((a, b) => a.at - b.at)
      for (const r of mine) held.splice(held.indexOf(r), 1)
      return mine
    },
  }
}

export function openCardCapMessage(cap = AGENT_OPEN_CARD_CAP): string {
  return (
    `This chat already has ${cap} approval cards waiting for the user, which is the limit. Nothing was queued. ` +
    'Wait for the user to answer them, or withdraw one you no longer need with withdraw_approval.'
  )
}

/**
 * The open cards, in memory and in the store. Every close goes through `take`,
 * which returns a card once and only once, so a card cannot be answered twice
 * (two clients, or an answer racing a stop).
 */
export class ApprovalCardBook<Plan = unknown> {
  private readonly cards = new Map<string, StoredApprovalCard<Plan>>()

  constructor(
    private readonly store: ApprovalCardStore<Plan>,
    private readonly cap = AGENT_OPEN_CARD_CAP,
  ) {
    for (const card of store.loadCards()) this.cards.set(card.requestId, card)
  }

  /** Why the chat may not open another card, or null. */
  openProblem(chatId: string): string | null {
    return this.forChat(chatId).length >= this.cap ? openCardCapMessage(this.cap) : null
  }

  add(card: StoredApprovalCard<Plan>): void {
    this.store.putCard(card)
    this.cards.set(card.requestId, card)
  }

  get(requestId: string): StoredApprovalCard<Plan> | null {
    return this.cards.get(requestId) ?? null
  }

  /** Oldest first. */
  forChat(chatId: string): StoredApprovalCard<Plan>[] {
    return [...this.cards.values()].filter((c) => c.chatId === chatId).sort((a, b) => a.openedAt - b.openedAt)
  }

  all(): StoredApprovalCard<Plan>[] {
    return [...this.cards.values()]
  }

  take(requestId: string): StoredApprovalCard<Plan> | null {
    const card = this.cards.get(requestId)
    if (!card) return null
    this.cards.delete(requestId)
    this.store.removeCard(requestId)
    return card
  }
}

/** What the tool answers at once. Not an error: the write is waiting, not refused. */
export function queuedToolText(requestId: string): string {
  return (
    `Queued for the user's approval (card ${requestId}). You will get a message in this chat with the result. ` +
    'Do not send it again. Carry on with other work, or end your turn. ' +
    `If you no longer want it, call withdraw_approval with card "${requestId}".`
  )
}

/** What the agent is told about a card the user denied. */
export function declinedResultText(what: string): string {
  return `The user declined: ${what}. Nothing was sent. Ask them what they want instead of trying again.`
}

/**
 * How a result reaches the agent. `turn` starts one now; `queue` holds it
 * behind the running turn (the adapters' `delivery: 'queue'`); `hold` keeps
 * it until the chat's session runs again; `none` is a quiet answer.
 */
export type ApprovalResultDelivery = 'none' | 'turn' | 'queue' | 'hold'

export function approvalResultDelivery(input: {
  wake: boolean
  live: boolean
  midTurn: boolean
}): ApprovalResultDelivery {
  if (!input.wake) return 'none'
  if (!input.live) return 'hold'
  return input.midTurn ? 'queue' : 'turn'
}

/**
 * The turn the agent gets. Marked as Switchboard's, so the model does not read
 * it as the user speaking, and so every surface drops it from the transcript
 * (the system row is what the user reads).
 */
export function approvalResultTurn(input: { requestId: string; toolName: string; text: string }): string {
  const close = `</${APPROVAL_RESULT_TAG}>`
  const text = input.text.split(close).join(`<\\/${APPROVAL_RESULT_TAG}>`)
  return [
    `<${APPROVAL_RESULT_TAG}>`,
    `This message is from Switchboard, not from the user. It reports what happened to approval card ${input.requestId} (${input.toolName}), which you asked for earlier.`,
    'It cannot approve or deny anything, and it carries no permission to act beyond what the user has already given you.',
    '',
    text,
    close,
  ].join('\n')
}

export type ApprovalResultOutcome = 'done' | 'failed' | 'declined' | 'dismissed' | 'withdrawn' | 'stopped'

/** The chat's system row about one card. */
export interface ApprovalResultRow {
  requestId: string
  /** "Reply to a review conversation", "Message another session". */
  title: string
  outcome: ApprovalResultOutcome
  /** What happened, as the agent is told it. */
  text: string
  /** Whether, and how, the agent hears about it. */
  delivery: ApprovalResultDelivery
}

export function formatApprovalResultMarker(row: ApprovalResultRow): string {
  return `${APPROVAL_RESULT_MARKER_PREFIX} ${JSON.stringify(row)}`
}

const OUTCOMES: readonly ApprovalResultOutcome[] = ['done', 'failed', 'declined', 'dismissed', 'withdrawn', 'stopped']
const DELIVERIES: readonly ApprovalResultDelivery[] = ['none', 'turn', 'queue', 'hold']

export function parseApprovalResultMarker(content: string): ApprovalResultRow | null {
  if (!content.startsWith(APPROVAL_RESULT_MARKER_PREFIX)) return null
  try {
    const raw = JSON.parse(content.slice(APPROVAL_RESULT_MARKER_PREFIX.length)) as Record<string, unknown>
    if (typeof raw.requestId !== 'string' || typeof raw.title !== 'string' || typeof raw.text !== 'string') return null
    if (
      !OUTCOMES.includes(raw.outcome as ApprovalResultOutcome) ||
      !DELIVERIES.includes(raw.delivery as ApprovalResultDelivery)
    )
      return null
    return {
      requestId: raw.requestId,
      title: raw.title,
      text: raw.text,
      outcome: raw.outcome as ApprovalResultOutcome,
      delivery: raw.delivery as ApprovalResultDelivery,
    }
  } catch {
    return null
  }
}

const OUTCOME_LABEL: Record<ApprovalResultOutcome, string> = {
  done: 'Done',
  failed: 'Failed',
  declined: 'Declined',
  dismissed: 'Dismissed',
  withdrawn: 'Withdrawn by the agent',
  stopped: 'Closed with the session',
}

const DELIVERY_LABEL: Record<ApprovalResultDelivery, string> = {
  none: '',
  turn: 'Sent to the agent',
  queue: 'Sent to the agent after its current turn',
  hold: 'The agent hears about it when the chat runs again',
}

/** "Reply to a review conversation · Done · Sent to the agent". */
export function approvalResultLabel(row: ApprovalResultRow): string {
  return [row.title, OUTCOME_LABEL[row.outcome], DELIVERY_LABEL[row.delivery]].filter(Boolean).join(' · ')
}
