/**
 * Approval cards the Switchboard MCP server opens itself.
 *
 * None of the three agents asks the user before one of our MCP tools runs in
 * every mode (OpenCode never does, Codex only asks yes or no), so the server
 * is the gate. A card is an ordinary `request.opened` / `request.closed` pair
 * on the chat's event stream; the answer arrives on
 * `provider:respond-to-request`, which the registry routes here for ids this
 * broker minted instead of to the adapter.
 *
 * The tool call does not wait for the answer (`shared/agent-approval-cards.ts`):
 * the card is stored with the write it would run (`plan`) and stays open, with
 * no time limit and across a restart, until the user answers or dismisses it,
 * the agent withdraws it, or the user stops or archives the chat. Every card
 * closes exactly once, and only an approval runs its write, which `onClosed`
 * does.
 */
import { randomBytes } from 'node:crypto'
import type { ApprovalDecision, RuntimeEvent, RuntimeRequestOpenedEvent } from '@shared/provider-events'
import type { HostWriteCard, HostWriteResponse } from '@shared/agent-host-writes'
import {
  AGENT_APPROVAL_ID_PREFIX,
  ApprovalCardBook,
  isAgentApprovalCardId,
  closeFromAnswer,
  memoryApprovalCardStore,
  type ApprovalCardClose,
  type ApprovalCardStore,
  type StoredApprovalCard,
} from '@shared/agent-approval-cards'
import { HOST_WRITE_SHOWN_REQUIRED, hostWriteApprovalProblem, hostWriteShownDigest } from '@shared/host-write-phone'
import type { PrWritePlan } from './pr-tools'
import type { PeerSendPlan } from './peer-mcp-tools'
import { createMainLogger } from '../logger'

const log = createMainLogger('mcp:approvals')

/** The write an approval runs, as data, so it survives a restart. */
export type AgentWritePlan = PrWritePlan | PeerSendPlan

export type AgentApprovalCard = StoredApprovalCard<AgentWritePlan>

export interface AgentApprovalRequest {
  threadId: string
  /** The root conversation id. */
  chatId: string
  toolName: string
  detail: string
  hostWrite?: HostWriteCard
  plan: AgentWritePlan
}

export type AgentApprovalAnswer = { ok: true } | { ok: false; message: string }

export type AgentApprovalOpened = { ok: true; requestId: string } | { ok: false; message: string }

export interface AgentApprovalBrokerDeps {
  publish(event: RuntimeEvent): void
  /** Whether two ids name the same chat (a rotated provider session id vs. the root). */
  sameChat?(a: string, b: string): boolean
  store?: ApprovalCardStore<AgentWritePlan>
  /** A card closed: run the write on an approval, and tell the chat and the agent. */
  onClosed?(card: AgentApprovalCard, close: ApprovalCardClose, response: HostWriteResponse): void
  now?(): number
}

export class AgentApprovalBroker {
  private readonly book: ApprovalCardBook<AgentWritePlan>

  constructor(private readonly deps: AgentApprovalBrokerDeps) {
    this.book = new ApprovalCardBook(restoreSafely(deps.store ?? memoryApprovalCardStore()))
    const restored = this.book.all().length
    if (restored > 0) log.info(`restored ${restored} open approval cards`)
  }

  static owns(requestId: unknown): boolean {
    return isAgentApprovalCardId(requestId)
  }

  /** Why the chat may not open another card (the cap), or null. Asked before the write budget is charged. */
  openProblem(chatId: string): string | null {
    return this.book.openProblem(chatId)
  }

  open(req: AgentApprovalRequest): AgentApprovalOpened {
    const problem = this.book.openProblem(req.chatId)
    if (problem) return { ok: false, message: problem }
    const requestId = `${AGENT_APPROVAL_ID_PREFIX}${Date.now()}_${randomBytes(4).toString('hex')}`
    const card: AgentApprovalCard = {
      requestId,
      chatId: req.chatId,
      threadId: req.threadId,
      toolName: req.toolName,
      detail: req.detail,
      hostWrite: req.hostWrite ?? null,
      plan: req.plan,
      openedAt: this.deps.now?.() ?? Date.now(),
    }
    this.book.add(card)
    this.deps.publish(openedEvent(card))
    return { ok: true, requestId }
  }

  /** The chat's open cards as their `request.opened` events, for a client recovering them. */
  pendingEvents(chatId: string): RuntimeRequestOpenedEvent[] {
    return this.book.forChat(chatId).map(openedEvent)
  }

  /**
   * The user's answer. `approver.mayApproveHostWrite` is false for a device
   * scope that cannot post to a pull request: it may still deny a host write,
   * which is harmless, but not approve one. `approver.mustProveShown` is true
   * for a device that cannot edit (a phone): its approval must carry the
   * digest of the draft it showed in full (`response.shown`), so an app that
   * showed a shortened card cannot approve it. `approver.label` names the
   * client in the log line an approved host write leaves. `response.quiet`
   * approves or denies without waking the agent.
   */
  respond(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
    response: HostWriteResponse,
    approver: { mayApproveHostWrite: boolean; mustProveShown?: boolean; label: string },
  ): AgentApprovalAnswer {
    const card = this.book.get(requestId)
    if (!card) return { ok: false, message: 'That request is no longer open.' }
    const same = this.deps.sameChat ?? ((a, b) => a === b)
    if (!same(card.threadId, threadId)) return { ok: false, message: 'That request belongs to another chat.' }
    if (decision === 'approve' && card.hostWrite) {
      if (!approver.mayApproveHostWrite) {
        log.warn(`refused a host write approval from ${approver.label}, which lacks the scope: ${requestId}`)
        return { ok: false, message: 'This device cannot post to a pull request. Approve it on the desktop.' }
      }
      if (approver.mustProveShown && response.shown !== hostWriteShownDigest(requestId, card.hostWrite)) {
        log.warn(
          `refused a host write approval from ${approver.label}, which did not show the whole draft: ${requestId}`,
        )
        return { ok: false, message: HOST_WRITE_SHOWN_REQUIRED }
      }
      const problem = hostWriteApprovalProblem(card.hostWrite, response)
      if (problem) return { ok: false, message: problem }
      log.info(
        `host write ${card.hostWrite.action} on ${card.hostWrite.prLabel} approved by ${approver.label}: ${requestId}`,
      )
    }
    this.close(requestId, closeFromAnswer(decision, response.quiet === true), response, threadId)
    return { ok: true }
  }

  /** The agent took a card back (`withdraw_approval`). Only one of its own chat's. */
  withdraw(chatId: string, requestId: string): AgentApprovalAnswer {
    const card = this.book.get(requestId)
    if (!card || card.chatId !== chatId)
      return { ok: false, message: `No open approval card ${requestId} in this chat.` }
    this.close(requestId, { kind: 'withdrawn' }, {})
    return { ok: true }
  }

  /** The user stopped or archived the chat: nothing it asked for can still happen. */
  closeChat(chatId: string): void {
    for (const card of this.book.forChat(chatId)) this.close(card.requestId, { kind: 'stopped' }, {})
  }

  private close(requestId: string, close: ApprovalCardClose, response: HostWriteResponse, answeredOn?: string): void {
    const card = this.book.take(requestId)
    if (!card) return
    if (close.kind === 'stopped' || close.kind === 'withdrawn')
      log.info(`card ${requestId} closed without an answer: ${close.kind}`)
    const decision: ApprovalDecision = close.kind === 'approve' ? 'approve' : 'deny'
    this.deps.publish({ type: 'request.closed', threadId: card.threadId, requestId, decision })
    // A card restored after a restart was recovered under whatever id the
    // answering client knows the chat by, which can differ from the one it opened on.
    if (answeredOn && answeredOn !== card.threadId) {
      this.deps.publish({ type: 'request.closed', threadId: answeredOn, requestId, decision })
    }
    this.deps.onClosed?.(card, close, response)
  }
}

/** A store that cannot be read (a damaged row, a closed database) leaves the broker empty rather than failing the backend. */
function restoreSafely(store: ApprovalCardStore<AgentWritePlan>): ApprovalCardStore<AgentWritePlan> {
  return {
    ...store,
    loadCards: () => {
      try {
        return store.loadCards()
      } catch (err) {
        log.error('could not restore open approval cards; they stay in the store until it can be read', err)
        return []
      }
    },
  }
}

function openedEvent(card: AgentApprovalCard): RuntimeRequestOpenedEvent {
  return {
    type: 'request.opened',
    threadId: card.threadId,
    requestId: card.requestId,
    requestType: 'tool',
    toolName: card.toolName,
    detail: card.detail,
    ...(card.hostWrite ? { hostWrite: card.hostWrite } : {}),
  }
}
