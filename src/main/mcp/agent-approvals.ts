/**
 * Approval cards the Switchboard MCP server opens itself.
 *
 * None of the three agents asks the user before one of our MCP tools runs in
 * every mode (OpenCode never does, Codex only asks yes or no), so the server
 * is the gate, and this is where it waits. A card is an ordinary
 * `request.opened` / `request.closed` pair on the chat's event stream; the
 * answer arrives on `provider:respond-to-request`, which the registry routes
 * here for ids this broker minted instead of to the adapter.
 *
 * Every card closes exactly once: answered, expired, cancelled by the agent
 * (it timed out or the user stopped the turn), or its session stopped. A card
 * that closes any way but an approval never runs its write.
 */
import { randomBytes } from 'node:crypto'
import type { ApprovalDecision, RuntimeEvent } from '@shared/provider-events'
import { HOST_WRITE_APPROVAL_TTL_MS, type HostWriteCard, type HostWriteResponse } from '@shared/agent-host-writes'
import { HOST_WRITE_SHOWN_REQUIRED, hostWriteApprovalProblem, hostWriteShownDigest } from '@shared/host-write-phone'
import { createMainLogger } from '../logger'

const log = createMainLogger('mcp:approvals')

const REQUEST_ID_PREFIX = 'sbmcp_'

export type AgentApprovalDenyReason = 'user' | 'expired' | 'cancelled' | 'stopped'

export type AgentApprovalOutcome =
  | { decision: 'approve'; response: HostWriteResponse }
  | { decision: 'deny'; reason: AgentApprovalDenyReason }

export interface AgentApprovalRequest {
  threadId: string
  toolName: string
  detail: string
  hostWrite?: HostWriteCard
  signal?: AbortSignal
}

export type AgentApprovalAnswer = { ok: true } | { ok: false; message: string }

export interface AgentApprovalBrokerDeps {
  publish(event: RuntimeEvent): void
  /** Whether two ids name the same chat (a rotated provider session id vs. the root). */
  sameChat?(a: string, b: string): boolean
  ttlMs?: number
}

interface OpenCard {
  requestId: string
  threadId: string
  hostWrite: HostWriteCard | null
  settle(outcome: AgentApprovalOutcome): void
}

export class AgentApprovalBroker {
  private open = new Map<string, OpenCard>()
  private readonly ttlMs: number

  constructor(private readonly deps: AgentApprovalBrokerDeps) {
    this.ttlMs = deps.ttlMs ?? HOST_WRITE_APPROVAL_TTL_MS
  }

  static owns(requestId: unknown): boolean {
    return typeof requestId === 'string' && requestId.startsWith(REQUEST_ID_PREFIX)
  }

  ask(req: AgentApprovalRequest): Promise<AgentApprovalOutcome> {
    if (req.signal?.aborted) return Promise.resolve({ decision: 'deny', reason: 'cancelled' })
    const requestId = `${REQUEST_ID_PREFIX}${Date.now()}_${randomBytes(4).toString('hex')}`
    return new Promise<AgentApprovalOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const onAbort = (): void => card.settle({ decision: 'deny', reason: 'cancelled' })
      const card: OpenCard = {
        requestId,
        threadId: req.threadId,
        hostWrite: req.hostWrite ?? null,
        settle: (outcome) => {
          if (!this.open.delete(requestId)) return
          if (timer) clearTimeout(timer)
          req.signal?.removeEventListener('abort', onAbort)
          if (outcome.decision === 'deny' && outcome.reason !== 'user') {
            log.info(`card ${requestId} closed without an answer: ${outcome.reason}`)
          }
          this.deps.publish({ type: 'request.closed', threadId: req.threadId, requestId, decision: outcome.decision as ApprovalDecision })
          resolve(outcome)
        },
      }
      this.open.set(requestId, card)
      timer = setTimeout(() => card.settle({ decision: 'deny', reason: 'expired' }), this.ttlMs)
      timer.unref?.()
      req.signal?.addEventListener('abort', onAbort, { once: true })
      this.deps.publish({
        type: 'request.opened',
        threadId: req.threadId,
        requestId,
        requestType: 'tool',
        toolName: req.toolName,
        detail: req.detail,
        ...(req.hostWrite ? { hostWrite: req.hostWrite } : {}),
      })
    })
  }

  /**
   * The user's answer. `approver.mayApproveHostWrite` is false for a device
   * scope that cannot post to a pull request: it may still deny a host write,
   * which is harmless, but not approve one. `approver.mustProveShown` is true
   * for a device that cannot edit (a phone): its approval must carry the
   * digest of the draft it showed in full (`response.shown`), so an app that
   * showed a shortened card cannot approve it. `approver.label` names the
   * client in the log line an approved host write leaves.
   */
  respond(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
    response: HostWriteResponse,
    approver: { mayApproveHostWrite: boolean; mustProveShown?: boolean; label: string },
  ): AgentApprovalAnswer {
    const card = this.open.get(requestId)
    if (!card) return { ok: false, message: 'That request is no longer open.' }
    const same = this.deps.sameChat ?? ((a, b) => a === b)
    if (!same(card.threadId, threadId)) return { ok: false, message: 'That request belongs to another chat.' }
    if (decision === 'approve' && card.hostWrite) {
      if (!approver.mayApproveHostWrite) {
        log.warn(`refused a host write approval from ${approver.label}, which lacks the scope: ${requestId}`)
        return { ok: false, message: 'This device cannot post to a pull request. Approve it on the desktop.' }
      }
      if (approver.mustProveShown && response.shown !== hostWriteShownDigest(requestId, card.hostWrite)) {
        log.warn(`refused a host write approval from ${approver.label}, which did not show the whole draft: ${requestId}`)
        return { ok: false, message: HOST_WRITE_SHOWN_REQUIRED }
      }
      const problem = hostWriteApprovalProblem(card.hostWrite, response)
      if (problem) return { ok: false, message: problem }
      log.info(`host write ${card.hostWrite.action} on ${card.hostWrite.prLabel} approved by ${approver.label}: ${requestId}`)
    }
    card.settle(decision === 'approve' ? { decision: 'approve', response } : { decision: 'deny', reason: 'user' })
    return { ok: true }
  }

  /** The session stopped: nothing it asked for can still happen. */
  closeThread(threadId: string): void {
    for (const card of [...this.open.values()]) {
      if (card.threadId === threadId) card.settle({ decision: 'deny', reason: 'stopped' })
    }
  }

  closeAll(): void {
    for (const card of [...this.open.values()]) card.settle({ decision: 'deny', reason: 'stopped' })
  }
}
