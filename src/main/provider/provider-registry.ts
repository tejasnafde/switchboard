/**
 * Provider registry - manages adapter instances and routes operations.
 */

import type { PerfSpan } from '@shared/perf-timing'
import { perfSpan } from '../perf'
import type { BackendHost } from '../backend/host'
import { AppChannels, ProviderChannels } from '@shared/ipc-channels'
import { applyContentText } from '@shared/content-stream'
import { createMainLogger as createLogger } from '../logger'
import { trackAnalyticsEvent } from '../analytics'
import { ClaudeAdapter } from './adapters/claude-adapter'
import { CodexAdapter } from './adapters/codex-adapter'
import { demoAdapters } from './adapters/demo-adapter'
import { OpencodeAcpAdapter } from './adapters/opencode-acp-adapter'
import { AcpAdapter } from './adapters/acp/acp-adapter'
import { genericAcpLaunchConfig } from './adapters/acp/agents'
import { assertCwdReadable } from '../path-access'
import { RuntimeEventBus } from './event-bus'
import { DriftWatcher, parseWorktreeList, type WorktreeRef } from './worktree-drift'
import {
  ExecutionRootCoordinator,
  type ExecutionRootHost,
  type ProviderHandle,
  type TargetResolution,
} from './execution-root-coordinator'
import { resolveExecutionRoot, samePath, type ExecutionRoot, LOCAL_MACHINE_ID } from '@shared/execution-root'
import type { RelocateExecutionRootRequest } from '@shared/execution-root-relocation'
import { ExecFileGitWorktreeAdapter } from '../worktree-creation/git-adapter'
import { getCurrentBranch } from '../git/refs'
import { access } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { realpathOrAncestor } from '../ipc/files'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CheckpointTracker, type TurnCheckpointStore } from './checkpoint-tracker'
import { sqliteTurnCheckpointStore } from '../db/turn-checkpoints'
import { sqliteQueuedTurnRowStore, type QueuedTurnRowStore } from '../db/queued-turn-rows'
import { notebookManager } from '../notebooks/manager'
import { filterNotebookFileEdits } from '../notebooks/file-edit-filter'
import { getProviderInstanceFull, resolveProviderInstance, listOauthDirsForAgent } from '../db/provider-instances'
import { MergeBackService } from '../conversations/merge-back'
import { SqliteMergeBackStore } from '../db/merge-backs'
import { commitConversationProviderSwitch, getConversationRuntimeMode, getSetting, deleteUserMessage, recordConversationWorkedWorktrees, type ConversationFollowSuggestions, recordConversationSegment, recordThreadSession, updateConversationSessionId, saveMessageIfAbsent, saveActivityMessageIfAbsent, setConversationStatusLine, threadFamilyIds, getConversationById, getConversationTitle, resolveRootThreadId, rewriteSystemMarker, getDb, getConversationExecutionRoot, commitConversationExecutionRoot, setConversationRuntimeMode, getConversationModel, getConversationPendingHandoff, clearConversationPendingHandoff } from '../db/database'
import { SqliteTurnAcceptanceStore } from '../db/turn-acceptance'
import { currentBackendRequestContext, hashClientScope, describeRequestClient, remoteDeviceHasScope } from '../backend/request-context'
import {
  AtomicUserTurnSubmission,
  DurableTurnAcceptance,
  TurnNotAcceptedError,
  type TurnAcceptanceResult,
} from './durable-turn-acceptance'
import { sessionDefaultsFor } from './session-defaults'
import { QueuedTurnLedger } from './queued-turn-ledger'
import { queuedTurnComposerText } from '@shared/queued-turns'
import { echoMessageId, isRuntimeMode, REQUEST_EXPIRED, SESSION_START_STOPPED } from '@shared/provider-events'
import { isReasoningEffort } from '@shared/provider-option-memory'
import { promoteUnavailableReason, startsOwnProviderTurn, type QueuedTurnActionResult, type QueuedTurnSummary } from '@shared/turn-delivery'
import {
  errorMessage,
  isDefiniteAdapterPreconditionFailure,
  legacyAcceptanceResult,
  rejectedAtomicTurn,
} from './turn-submission-results'
import {
  PeerAgentSendGuard,
  PeerMessageGuard,
  nextHopDepth,
  peerMessageTooLarge,
  peerSentMarkerPrefix,
  wrapPeerMessage,
  type PeerMessageInput,
} from '@shared/peer-messaging'
import {
  formatUndeliveredMarker,
  parseUndeliveredMarker,
  PeerLinkBook,
  PEER_LINK_DURATION_SETTING,
  peerLinkDefaultWindow,
  PEER_LINK_NOT_DELIVERED,
  PEER_UNDELIVERED_MARKER_PREFIX,
  peerUndeliveredId,
  type PeerLinkRefusal,
  type PeerLinkView,
} from '@shared/peer-links'
import type { PeerSessionSummary, PeerToolHost } from './peer-tools'
import { AgentApprovalBroker, type AgentApprovalCard, type AgentWritePlan } from '../mcp/agent-approvals'
import { AgentWriteBudget } from '../mcp/agent-write-budget'
import { agentPullRequestAccess, buildPrTools, isPrWritePlan, prWritePlanSummary, runPrWritePlan } from '../mcp/pr-tools'
import { buildPrLinkTools } from '../mcp/pr-link-tools'
import { buildPeerMcpTools, runPeerSendPlan } from '../mcp/peer-mcp-tools'
import { buildApprovalMcpTools } from '../mcp/approval-mcp-tools'
import { sqliteApprovalCardStore } from '../db/agent-approval-cards'
import {
  approvalResultDelivery,
  approvalResultTurn,
  closeWakesAgent,
  declinedResultText,
  formatApprovalResultMarker,
  memoryApprovalCardStore,
  type ApprovalCardClose,
  type ApprovalCardStore,
  type ApprovalResultDelivery,
  type ApprovalResultOutcome,
} from '@shared/agent-approval-cards'
import { switchboardMcpServer, type SwitchboardMcpLaunch, type SwitchboardMcpServer } from '../mcp/switchboard-mcp-server'
import { hostWriteTitle, parseHostWriteResponse, type HostWriteResponse } from '@shared/agent-host-writes'
import { approvalChoiceOnly } from '@shared/host-write-phone'
import { defaultClaudeDir, prepareClaudeProfileSwitch } from './claude-session-migrate'
import { prepareCodexProfileSwitch } from './codex-session-migrate'
import { remoteBlockedProviderLabel, remoteProviderLoginPrompt, remoteProviderConfigDir, checkRemoteProviderAuth } from './remote-gate'
import type { AgentType, FileDiffAttachment, ToolCall } from '@shared/types'
import { fileDiffRowId, storedToolText, toolInputText, toolRowId } from '@shared/turn-activity'
import { storedTaskNoticeId, taskNotificationText } from '@shared/synthetic-message'
import type {
  ProviderAdapter,
  ProviderKind,
  ProviderSession,
  RuntimeEvent,
  SessionStartOpts,
  ApprovalDecision,
  RuntimeMode,
} from './types'
import {
  validateUserMessageImages,
  type ProviderInstanceSwitchRequest,
  type UserTurnSubmissionResult,
  type UserTurnSubmissionV1,
  type UserTurnResolutionV1,
  type RuntimeFileEditedEvent,
} from '@shared/provider-events'
import { agentLabel, isAgentProvider, toAgentProvider } from '@shared/types'
import { GENERIC_ACP_AGENTS, speaksAcp } from '@shared/acp-agents'
import { answeredHistory, buildHandoffPreamble, handoffBudgetChars, isHandoffSource, planTurnHandoff, stripHandoffPreamble } from '@shared/handoff'
import { loadConversationHistory } from '../conversations/history'
import { peekCatalog, probeCatalog } from './catalog-probe'
import { pendingRequestKey, type PendingBlockingEvent } from '@shared/pending-requests'
import { turnPreviewLine } from '@shared/turn-preview'

const log = createLogger('provider:registry')

/** Old plus new content. A bigger card still streams live, but is not stored. */
const MIRRORED_FILE_DIFF_MAX_CHARS = 2 * 1024 * 1024

/** Realpath, or the input when the path does not exist (a deleted worktree). */
function realpathSyncOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}


type ProviderEventGate = {
  state: 'staging' | 'flushing' | 'committed' | 'discarded'
  events: RuntimeEvent[]
}

type ProviderCredentialSnapshot = {
  instanceId?: string
  instanceName?: string
  resolvedEnv: Record<string, string>
  resolvedOauthDir: string | null
  remoteConfigDir?: string
}

type StoppedSessionSnapshot = {
  descriptor: ProviderSession
  credentials: ProviderCredentialSnapshot
}

export class ProviderRegistry implements PeerToolHost {
  private adapters: Map<ProviderKind, ProviderAdapter>
  private host: BackendHost
  /**
   * Per-session resolved adapter, so existing sessions stay pinned to the
   * adapter instance they started on even if we swap adapters at runtime.
   */
  private sessionAdapters = new Map<string, ProviderAdapter>()
  /** Working-tree root per session, captured at startSession for checkpointing. */
  private sessionCwd = new Map<string, string>()
  /** Last status published per live thread. Cleared with the session. */
  private sessionStatus = new Map<string, ProviderSession['status']>()
  /** The last `session.provider` published per thread, re-sent with a mode change. */
  private sessionIdentity = new Map<string, Extract<RuntimeEvent, { type: 'session.provider' }>>()
  /** Mode a held message was sent with, by its chat row id: it applies only when that message starts. */
  private heldTurnModes = new Map<string, { threadId: string; mode: RuntimeMode }>()
  /** Descriptor per live thread, so a late-connecting client can adopt it. */
  private sessionDescriptors = new Map<string, ProviderSession>()
  /**
   * Approval/question/plan cards still open per thread, keyed by
   * `pendingRequestKey` (requestId, or planId for a plan). Filled from the
   * same event path that updates `sessionStatus` below, so a client that
   * reconnected after a resume gap or reloaded the window can ask what it is
   * missing instead of waiting on a card that will never arrive as a live
   * event again. See `getPendingRequests` and `ProviderChannels.GET_PENDING_REQUESTS`.
   */
  private pendingRequests = new Map<string, Map<string, PendingBlockingEvent>>()
  /** Exact credentials/config location used by the live adapter. Kept private
   * so a failed rotation can restore the same identity even if DB rows change. */
  private sessionCredentials = new Map<string, ProviderCredentialSnapshot>()
  /** Fences callbacks by provider-process execution, not conversation id. A
   * stopped source and its replacement intentionally share a thread id. */
  private sessionEpochs = new Map<string, number>()
  private nextSessionEpoch = 0
  /** Worktree list cache per repo folder (10s TTL, failures negatively
   *  cached, refs realpath-normalized once at fill). Drift state lives in
   *  the watcher, turn-scoped. */
  private worktreeCache = new Map<string, { at: number; refs: WorktreeRef[]; inflight?: Promise<WorktreeRef[]> }>()
  /**
   * Relocation transaction. Constructed in `registerHandlers`, because it
   * needs the same local `startSession`/`stopSession` closures the profile
   * switch uses - those ARE the drain and rollback boundary, and a second
   * implementation of them would be a second set of bugs.
   */
  private executionRoot: ExecutionRootCoordinator | null = null

  /** Provider events staged while a relocation is mid-flight, per thread. */
  private relocationGates = new Map<string, ProviderEventGate>()

  private driftWatcher = new DriftWatcher(
    (folder, fresh) => this.listWorktrees(folder, fresh),
    (p) => realpathOrAncestor(p)
  )

  /**
   * Derives per-file diff cards from git checkpoints around each turn -
   * provider-agnostic, so Claude / Codex / OpenCode all surface edits the
   * same way in chat.
   */
  private readonly checkpoints: CheckpointTracker
  private readonly atomicTurnSubmission: Pick<AtomicUserTurnSubmission, 'submit'> & Partial<Pick<AtomicUserTurnSubmission, 'resolve'>>
  /** Provider startup shared by every client that reaches a thread before its adapter exists. */
  private startingSessions = new Map<string, Promise<ProviderSession>>()
  /** Threads whose user pressed Stop while their session was still starting. */
  private stopRequestedDuringStart = new Set<string>()
  private managedSessionStarter: ((opts: SessionStartOpts) => Promise<ProviderSession>) | null = null
  private switchingSessions = new Set<string>()
  /** Turns that have claimed a thread but have not crossed the provider
   * boundary yet. Counted because Claude/Codex may accept more than one queued
   * turn; a Set would release the switch guard when only the first prepared. */
  private preparingTurns = new Map<string, number>()

  private beginPreparingTurn(threadId: string): void {
    this.preparingTurns.set(threadId, (this.preparingTurns.get(threadId) ?? 0) + 1)
  }

  private finishPreparingTurn(threadId: string): void {
    const remaining = (this.preparingTurns.get(threadId) ?? 0) - 1
    if (remaining > 0) this.preparingTurns.set(threadId, remaining)
    else this.preparingTurns.delete(threadId)
  }

  /**
   * Event bus that decouples adapter event emission from the consumer.
   * Today there's one consumer (the renderer bridge); the kanban board
   * adds a second (a task-state recorder) without touching adapters.
   */
  readonly bus: RuntimeEventBus
  /** Unsubscribe fn for the renderer bridge subscription. */
  private rendererUnsub: (() => void) | null = null

  // `adapters` is injectable for tests (e.g. a mock echo provider exercising
  // the full path over a WsHost); production passes none and gets the real set.
  constructor(
    host: BackendHost,
    adapters?: Map<ProviderKind, ProviderAdapter>,
    _turnAcceptance?: DurableTurnAcceptance,
    atomicTurnSubmission?: Pick<AtomicUserTurnSubmission, 'submit'> & Partial<Pick<AtomicUserTurnSubmission, 'resolve'>>,
    // Tests that inject adapters get no MCP server unless they pass one, so
    // they neither listen on a port nor write the bridge into the data dir.
    switchboardMcp: SwitchboardMcpServer | null = adapters ? null : switchboardMcpServer(),
    // Same rule for the card store: injected adapters mean a test, which gets
    // an in-memory store unless it passes one.
    approvalStore: ApprovalCardStore<AgentWritePlan> = adapters ? memoryApprovalCardStore() : sqliteApprovalCardStore(),
    // Tests get none unless they pass one.
    queuedRows: QueuedTurnRowStore | null = adapters ? null : sqliteQueuedTurnRowStore(() => getDb()),
    turnCheckpoints: TurnCheckpointStore | null = adapters ? null : sqliteTurnCheckpointStore(() => getDb()),
  ) {
    this.switchboardMcp = switchboardMcp
    this.approvalStore = approvalStore
    this.queuedRows = queuedRows
    this.checkpoints = new CheckpointTracker({ store: turnCheckpoints })
    this.sweepQueuedRowsFromEarlierLaunch()
    this.agentApprovals = new AgentApprovalBroker({
      publish: (event) => this.publish(event),
      sameChat: (a, b) => a === b || resolveRootThreadId(a) === resolveRootThreadId(b),
      store: approvalStore,
      onClosed: (card, close, response) => {
        this.reportAgentCard(card, close, response).catch((err) => log.error(`reporting approval card ${card.requestId} failed`, err))
      },
    })
    activeRegistry = this
    this.host = host
    // SB_DEMO_ADAPTER=1 swaps in the scripted adapter so the tour recorder
    // (videos/capture-tour.mjs) can capture agent-driven scenes without
    // credentials. Never set by a normal launch.
    this.adapters = adapters ?? (process.env.SB_DEMO_ADAPTER === '1'
      ? demoAdapters()
      : new Map<ProviderKind, ProviderAdapter>([
        ['claude', new ClaudeAdapter()],
        ['codex', new CodexAdapter()],
        ['opencode', new OpencodeAcpAdapter()],
        ...GENERIC_ACP_AGENTS.map((agent) => [agent, new AcpAdapter(genericAcpLaunchConfig(agent))] as const),
      ]))
    const turnStore = new SqliteTurnAcceptanceStore(() => getDb())
    this.atomicTurnSubmission = atomicTurnSubmission ?? new AtomicUserTurnSubmission({
      store: turnStore,
      publish: (event) => this.publish(event),
    })
    this.bus = new RuntimeEventBus()
    this.rendererUnsub = this.bus.subscribe((event) => this.forwardToRenderer(event))
    // Invalid mirror edits are fs-watch findings with no tool result to ride
    // on - surface them in chat as error events through this registry's bus.
    notebookManager.setPublisher((event) => this.publish(event))
  }

  getAdapter(provider: ProviderKind): ProviderAdapter | undefined {
    return this.adapters.get(provider)
  }

  /**
   * Renderer bridge subscriber: forward every event to the client via the
   * host (which no-ops if the window is gone). Other bus subscribers (kanban
   * recorder, etc.) receive it independently.
   */
  private forwardToRenderer(event: RuntimeEvent): void {
    this.host.emit(ProviderChannels.EVENT, event)
  }

  /** Breaks same-millisecond id collisions, which INSERT OR REPLACE would eat. */
  private savedMessageSeq = 0

  /**
   * Size, rate and duplicate limits for session-to-session messages. Held by
   * the backend so every client pointed at these sessions shares one budget.
   */
  private readonly peerGuard = new PeerMessageGuard()

  /**
   * Hop depth and per-sender budget for sends the AGENT chose to make. The
   * user's own `/send-to` skips both: a human pressing enter is the approval,
   * and there is nobody to run away from.
   */
  private readonly peerAgentGuard = new PeerAgentSendGuard()

  /**
   * Session links the user made, keyed by root conversation id. An agent send
   * along a link skips `peerAgentGuard` and spends the edge's own budget.
   * In memory on purpose: a restart stops every session, and a stop removes
   * its links, so nothing a restart could restore would still be valid.
   */
  private readonly peerLinks = new PeerLinkBook()

  /**
   * Approval cards the Switchboard MCP server opens for its own tools. Their
   * answers arrive on RESPOND_TO_REQUEST like any other and are routed here
   * by request id instead of to the adapter. Stored, so a card outlives the
   * agent's turn and a restart (`shared/agent-approval-cards.ts`).
   */
  private readonly agentApprovals: AgentApprovalBroker
  private readonly approvalStore: ApprovalCardStore<AgentWritePlan>
  private readonly queuedRows: QueuedTurnRowStore | null

  /** Serves this backend's MCP tools to every agent; one per process, shared across registries. */
  private readonly switchboardMcp: SwitchboardMcpServer | null

  /** Pull request writes per chat, shared by every client of this backend. */
  private readonly agentWriteBudget = new AgentWriteBudget()

  /**
   * Hop depth of each thread's current turn - how many consecutive
   * agent-initiated peer messages stand between it and a human message.
   *
   * Deliberately NOT cleared at turn end. A session that acted on a peer
   * message stays at that depth until the user speaks to it again, so an
   * unattended chain cannot continue past the limit by waiting a turn.
   */
  private turnDepth = new Map<string, number>()
  /** Context window (tokens) each provider last reported per resolved model, for handoff budgets. */
  private contextWindows = new Map<string, number>()

  /** Accepted turns not yet matched by a turn.completed event. This is a
   * count, not a boolean: a queued message is its own turn after the running
   * one, and a profile switch must wait for both. A steer joins the running
   * turn and is not counted (`startsOwnProviderTurn`). */
  private outstandingTurns = new Map<string, number>()

  private hasOutstandingTurn(threadId: string): boolean {
    return (this.outstandingTurns.get(threadId) ?? 0) > 0
  }

  private beginOutstandingTurn(threadId: string): void {
    this.outstandingTurns.set(threadId, (this.outstandingTurns.get(threadId) ?? 0) + 1)
  }

  private finishOutstandingTurn(threadId: string): void {
    const remaining = (this.outstandingTurns.get(threadId) ?? 0) - 1
    if (remaining > 0) this.outstandingTurns.set(threadId, remaining)
    else this.outstandingTurns.delete(threadId)
  }

  /** Messages adapters hold until the running turn ends; see `QueuedTurnLedger`. */
  private queuedTurns = new QueuedTurnLedger()
  /** A fork's summaries waiting in its parent until the parent's next user turn. */
  private readonly mergeBacks = new MergeBackService({
    store: new SqliteMergeBackStore(() => getDb()),
    rootId: resolveRootThreadId,
    fork: (id) => {
      const row = getConversationById(id)
      if (!row?.parent_conversation_id || !row.forked_at_message_id) return null
      return {
        id: row.id,
        title: row.title,
        parentId: row.parent_conversation_id,
        createdAt: row.created_at,
        worktreePath: row.worktree_path ?? null,
        worktreeBranch: row.worktree_branch ?? null,
      }
    },
    parent: (id) => {
      const row = getConversationById(id)
      return row ? { id: row.id, title: row.title, archived: row.archived === 1 } : null
    },
    loadMessages: async (id) => (await loadConversationHistory(id, getConversationById(id)?.project_path ?? '')).messages,
    forkBusy: (id) => {
      const live = this.liveSessionId(id)
      return live !== null && this.hasOutstandingTurn(live)
    },
    publishRow: (parentId, messageId, content, at) => this.publish({
      type: 'merge-back.row', threadId: this.liveSessionId(parentId) ?? parentId, messageId, content, at,
    }),
  })

  /** The live thread a client's id names: its own, or the root it rotated from. */
  private liveThreadId(threadId: string): string {
    return this.sessionAdapters.has(threadId) ? threadId : resolveRootThreadId(threadId)
  }

  listQueuedTurns(threadId: string): QueuedTurnSummary[] {
    return this.queuedTurns.list(this.liveThreadId(threadId))
  }

  /**
   * Send a queued message into the running turn now, or take it back.
   * Outstanding-turn accounting is not done here but on the adapter's
   * `turn.dequeued`, in `publish`, so every way out of the queue settles it
   * in one place.
   */
  private async actOnQueuedTurn(action: 'promote' | 'cancel', threadId: string, messageId: string): Promise<QueuedTurnActionResult> {
    const live = this.liveThreadId(threadId)
    const turn = this.queuedTurns.get(live, messageId)
    if (turn?.failed) return this.actOnFailedQueuedTurn(action, live, messageId)
    const adapter = this.sessionAdapters.get(live)
    if (!turn || !adapter) {
      return { ok: false, reason: 'not-found', message: 'This message is no longer queued.' }
    }
    const unavailable = action === 'promote' ? promoteUnavailableReason(adapter.provider) : null
    const run = action === 'promote' ? adapter.promoteQueuedTurn : adapter.cancelQueuedTurn
    if (unavailable || !run) {
      return { ok: false, reason: 'unsupported', message: unavailable ?? 'This provider cannot change its queue.' }
    }
    let done: boolean
    try {
      done = await run.call(adapter, live, messageId)
    } catch (err) {
      log.warn(`${action} of queued message ${messageId} on ${live} failed: ${errorMessage(err)}`)
      return { ok: false, reason: 'failed', message: errorMessage(err) }
    }
    if (!done) {
      return { ok: false, reason: 'not-found', message: 'This message already started.' }
    }
    if (action === 'cancel') {
      // The row was committed with the accepted turn; the agent never saw it.
      try {
        deleteUserMessage(resolveRootThreadId(live), messageId)
      } catch (err) {
        log.warn(`could not delete cancelled queued message ${messageId}: ${errorMessage(err)}`)
      }
    }
    return { ok: true, turn }
  }

  /**
   * A queued message that could not start is no longer the adapter's: the
   * ledger keeps it, marked, so the user can take it back. It cannot be sent
   * now; Cancel puts its text back in the composer.
   */
  private actOnFailedQueuedTurn(action: 'promote' | 'cancel', live: string, messageId: string): QueuedTurnActionResult {
    if (action === 'promote') {
      return { ok: false, reason: 'failed', message: 'This message was not sent. Cancel it to edit it and send it again.' }
    }
    const turn = this.queuedTurns.removeFailed(live, messageId)
    if (!turn) return { ok: false, reason: 'not-found', message: 'This message is no longer queued.' }
    this.publish({ type: 'turn.dequeued', threadId: live, messageId, reason: 'cancelled' })
    try {
      deleteUserMessage(resolveRootThreadId(live), messageId)
    } catch (err) {
      log.warn(`could not delete failed queued message ${messageId}: ${errorMessage(err)}`)
    }
    return { ok: true, turn }
  }

  /** Start a queue the adapter held after a failed or usage-limited turn. */
  private async resumeQueuedTurns(threadId: string): Promise<{ ok: boolean; message?: string }> {
    const live = this.liveThreadId(threadId)
    const adapter = this.sessionAdapters.get(live)
    if (!adapter?.resumeQueuedTurns) return { ok: false, message: 'Nothing is held for this chat.' }
    try {
      return (await adapter.resumeQueuedTurns(live)) ? { ok: true } : { ok: false, message: 'Nothing is held for this chat.' }
    } catch (err) {
      log.warn(`resume of the held queue on ${live} failed: ${errorMessage(err)}`)
      return { ok: false, message: errorMessage(err) }
    }
  }

  /**
   * In-flight assistant text per thread, mirrored to SQLite on turn end.
   * Without it a reply lives only in the provider's transcript file, which
   * Claude Code prunes and rotates. Persisted here, not in ChatPanel, for the
   * same reason as the error card above: a headless server has no window.
   */
  private pendingAssistantText = new Map<string, Map<string, { text: string; at: number }>>()

  /** Fold one content delta into the in-flight turn buffer. */
  private bufferAssistantText(event: RuntimeEvent): void {
    if (event.type !== 'content' || event.streamKind !== 'assistant') return
    let byMessage = this.pendingAssistantText.get(event.threadId)
    if (!byMessage) {
      byMessage = new Map()
      this.pendingAssistantText.set(event.threadId, byMessage)
    }
    const pending = byMessage.get(event.messageId)
    byMessage.set(event.messageId, {
      text: applyContentText(pending?.text, { text: event.text, append: event.append }),
      // Last chunk, not flush time: a reload sorts by it and matches it to the
      // transcript line written when the message finished. Stamping the whole
      // turn at its end put interim text below the answer.
      at: Date.now(),
    })
  }

  /**
   * In-flight tool calls per thread, mirrored beside the text. Only Claude's
   * transcript keeps them, so a Codex, OpenCode or demo chat came back from a
   * reload with no "Used N tools" row.
   */
  private pendingToolCalls = new Map<string, Map<string, { call: ToolCall; at: number }>>()

  private bufferToolCall(event: RuntimeEvent): void {
    if (event.type === 'tool.started') {
      let byTool = this.pendingToolCalls.get(event.threadId)
      if (!byTool) {
        byTool = new Map()
        this.pendingToolCalls.set(event.threadId, byTool)
      }
      const pending = byTool.get(event.toolId)
      byTool.set(event.toolId, {
        call: { ...pending?.call, id: event.toolId, name: event.toolName, input: storedToolText(toolInputText(event.input)) },
        at: pending?.at ?? Date.now(),
      })
    } else if (event.type === 'tool.completed') {
      const pending = this.pendingToolCalls.get(event.threadId)?.get(event.toolId)
      if (pending && event.output !== undefined) pending.call = { ...pending.call, output: storedToolText(event.output) }
    }
  }

  /**
   * Mirror the turn's assistant messages and tool calls, then drop the
   * buffers. Only a completed turn replaces the stored status line: a stop
   * mid-turn would leave half a sentence as the chat's summary.
   */
  private flushTurnMirror(threadId: string, turnCompleted: boolean): void {
    const byMessage = this.pendingAssistantText.get(threadId)
    this.pendingAssistantText.delete(threadId)
    // The buffer holds exactly this turn's assistant messages, in order.
    const statusLine = turnPreviewLine([...byMessage?.values() ?? []].map(({ text }) => ({ text, isAssistant: true, isUser: false })))
    if (turnCompleted && statusLine) {
      try {
        setConversationStatusLine(threadId, statusLine)
        // Lists that are not showing this chat live re-read the stored line.
        this.host.emit(AppChannels.CONVERSATIONS_CHANGED)
      } catch (err) {
        log.warn(`failed to store status line for ${threadId}: ${err}`)
      }
    }
    for (const [messageId, { text, at }] of byMessage ?? []) {
      if (!text.trim()) continue
      try {
        saveMessageIfAbsent(messageId, threadId, 'assistant', text, undefined, undefined, at)
      } catch (err) {
        log.warn(`failed to mirror assistant message ${messageId} for ${threadId}: ${err}`)
      }
    }
    const byTool = this.pendingToolCalls.get(threadId)
    this.pendingToolCalls.delete(threadId)
    for (const { call, at } of byTool?.values() ?? []) {
      try {
        saveActivityMessageIfAbsent({ id: toolRowId(threadId, call.id), conversationId: threadId, timestamp: at, toolCalls: [call] })
      } catch (err) {
        log.warn(`failed to mirror tool call ${call.id} for ${threadId}: ${err}`)
      }
    }
  }

  /**
   * Mirror one changed-file card as it is published. Stamped with the turn's
   * end, not now: the diff runs after it, and a message sent meanwhile would
   * otherwise sort first and take the cards into the next turn on reload.
   */
  private mirrorFileEdit(event: RuntimeFileEditedEvent, turnEndedAt: number): void {
    const fileDiff: FileDiffAttachment = {
      fileEditId: event.fileEditId,
      repoRoot: event.repoRoot,
      relPath: event.relPath,
      changeKind: event.changeKind,
      oldContent: event.oldContent,
      newContent: event.newContent,
      status: 'pending',
      ...(event.noRevert ? { noRevert: event.noRevert } : {}),
    }
    const chars = fileDiff.oldContent.length + fileDiff.newContent.length
    if (chars > MIRRORED_FILE_DIFF_MAX_CHARS) {
      log.info(`not mirroring the ${event.relPath} diff card for ${event.threadId}: ${chars} chars`)
      return
    }
    try {
      saveActivityMessageIfAbsent({ id: fileDiffRowId(event.fileEditId), conversationId: event.threadId, timestamp: turnEndedAt, fileDiff })
    } catch (err) {
      log.warn(`failed to mirror file edit ${event.fileEditId} for ${event.threadId}: ${err}`)
    }
  }

  private addPendingRequest(event: PendingBlockingEvent): void {
    let byKey = this.pendingRequests.get(event.threadId)
    if (!byKey) {
      byKey = new Map()
      this.pendingRequests.set(event.threadId, byKey)
    }
    byKey.set(pendingRequestKey(event), event)
  }

  private resolvePendingRequest(threadId: string, key: string): void {
    const byKey = this.pendingRequests.get(threadId)
    if (!byKey) return
    byKey.delete(key)
    if (byKey.size === 0) this.pendingRequests.delete(threadId)
  }

  /**
   * The provider can no longer take an answer for anything open on this
   * thread. Every client is told, so no card is left with live buttons that
   * would answer nothing. A plan needs no answer from the provider (Implement
   * sends a new turn), so it is dropped without a notice.
   */
  private expirePendingRequests(threadId: string, reason: string): void {
    const byKey = this.pendingRequests.get(threadId)
    this.pendingRequests.delete(threadId)
    for (const event of byKey?.values() ?? []) {
      if (event.type === 'plan.proposed') continue
      log.info(`request ${event.requestId} on ${threadId} expired: ${reason}`)
      this.publish({ type: 'request.expired', threadId, requestId: event.requestId, reason })
    }
  }

  /** Whether the provider still waits on this approval or question. */
  private holdsPendingRequest(threadId: string, requestId: string): boolean {
    return [threadId, resolveRootThreadId(threadId)].some((id) => this.pendingRequests.get(id)?.has(requestId))
  }

  /**
   * Drop only the `plan.proposed` entries for a thread - called when the
   * user responds with a new turn (see the two `turnDepth` reset sites
   * below). A running turn can still be blocked on an open approval or
   * question at that moment (a Codex steer, or a `delivery: 'queue'` send
   * both prepare a turn while one is in flight), and those close only
   * through their own `request.closed` / `question.answered` events - never
   * through this.
   */
  private clearPendingPlans(threadId: string): void {
    const byKey = this.pendingRequests.get(threadId)
    if (!byKey) return
    for (const [key, event] of byKey) {
      if (event.type === 'plan.proposed') byKey.delete(key)
    }
    if (byKey.size === 0) this.pendingRequests.delete(threadId)
  }

  /**
   * Original events for a thread's still-open cards. Resolves through
   * `resolveRootThreadId` because the id a client asks with can be the
   * rotated provider session id rather than the id these were recorded
   * under - the same gotcha `getConversationRuntimeMode` and friends hit
   * (see AGENTS.md's "Any new per-conversation setting..." note).
   */
  getPendingRequests(threadId: string): PendingBlockingEvent[] {
    const root = resolveRootThreadId(threadId)
    const byKey = this.pendingRequests.get(root)
    return [...(byKey ? byKey.values() : []), ...this.agentApprovals.pendingEvents(root)]
  }

  /** Whether any id of the thread has an accepted turn that has not completed. */
  isTurnInFlight(threadId: string): boolean {
    return threadFamilyIds(threadId).some((id) => this.hasOutstandingTurn(id))
  }

  /** Live sessions with their CURRENT status, not the status they started at. */
  listSessions(): ProviderSession[] {
    return [...this.sessionDescriptors.entries()].map(([threadId, session]) => {
      const title = getConversationTitle(threadId)
      return {
        ...session,
        status: this.sessionStatus.get(threadId) ?? session.status,
        ...(title ? { title } : {}),
      }
    })
  }

  /**
   * The other live sessions, for the `list_agent_sessions` tool.
   *
   * Keyed on the id each session started under, which is the id
   * `deliverPeerMessage` can look an adapter up by, so a model that passes one
   * back verbatim always resolves. Titles come from the DB rather than the
   * descriptor because that is what the user reads in the sidebar.
   */
  listPeerSessions(fromThreadId: string): PeerSessionSummary[] {
    const ownRoot = resolveRootThreadId(fromThreadId)
    const out: PeerSessionSummary[] = []
    for (const [threadId, session] of this.sessionDescriptors) {
      if (threadId === fromThreadId || resolveRootThreadId(threadId) === ownRoot) continue
      out.push({
        sessionId: threadId,
        title: getConversationTitle(threadId) ?? threadId,
        folder: this.sessionCwd.get(threadId) ?? session.cwd,
        provider: session.provider,
        midTurn: this.hasOutstandingTurn(threadId),
        linked: this.peerLinks.isLinked(ownRoot, resolveRootThreadId(threadId)),
      })
    }
    return out
  }

  isLinkedPeer(fromThreadId: string, sessionId: string): boolean {
    return this.peerLinks.isLinked(resolveRootThreadId(fromThreadId), resolveRootThreadId(sessionId))
  }

  /** The id a live session runs under for this id: itself, its root, or another id rotated from that root. */
  private liveSessionId(threadId: string): string | null {
    if (this.sessionAdapters.has(threadId)) return threadId
    const root = resolveRootThreadId(threadId)
    if (this.sessionAdapters.has(root)) return root
    for (const id of this.sessionAdapters.keys()) if (resolveRootThreadId(id) === root) return id
    return null
  }

  private isLiveSession(threadId: string): boolean {
    return this.liveSessionId(threadId) !== null
  }

  private sessionTitle(threadId: string): string {
    return getConversationTitle(threadId) ?? threadId
  }

  /**
   * Link two live sessions on this backend, or renew an existing link with a
   * fresh budget of `messages` and a window of `windowMs` (the Link duration
   * setting when omitted). Reached only from the LINK_PEER handler, which is
   * user-directed and admin-scoped: no agent tool calls this.
   */
  linkPeers(threadId: string, peerThreadId: string, messages?: number, windowMs?: number): PeerLinkView[] {
    const a = resolveRootThreadId(threadId)
    const b = resolveRootThreadId(peerThreadId)
    if (!this.isLiveSession(threadId)) throw new Error('This chat is not running. Send it a message first, then link it.')
    if (!this.isLiveSession(peerThreadId)) {
      throw new Error(`"${this.sessionTitle(peerThreadId)}" is not running. Open it, then link again.`)
    }
    const windowLength = windowMs ?? peerLinkDefaultWindow(getSetting(PEER_LINK_DURATION_SETTING))
    const result = this.peerLinks.link(a, b, 'user', Date.now(), messages, windowLength)
    if (!result.ok) throw new Error(result.message)
    log.info(`peer link ${result.created ? 'created' : 'renewed'}: ${a} <-> ${b}`)
    this.announcePeerLinks([a, b])
    return this.listPeerLinks(threadId)
  }

  /** Extend: more messages and a fresh window on one link. User-directed, admin-scoped. */
  extendPeerLink(threadId: string, peerThreadId: string): PeerLinkView[] {
    const a = resolveRootThreadId(threadId)
    const b = resolveRootThreadId(peerThreadId)
    const result = this.peerLinks.extend(a, b, 'user', Date.now())
    if (!result.ok) throw new Error(result.message)
    log.info(`peer link extended: ${a} <-> ${b}`)
    this.announcePeerLinks([a, b])
    return this.listPeerLinks(threadId)
  }

  /**
   * Keep a message a spent link refused, in the sender's chat, where the user
   * can read it and send it by hand. The agent is told to report it too, but
   * an agent running unattended may never get that far.
   */
  private recordUndelivered(input: {
    fromThreadId: string
    fromLabel: string
    targetRoot: string
    targetLabel: string
    text: string
    reason: PeerLinkRefusal
    notify: boolean
  }): void {
    const messageId = peerUndeliveredId(input.fromThreadId, input.targetRoot, input.text)
    const content = formatUndeliveredMarker({
      to: input.targetRoot, toLabel: input.targetLabel, reason: input.reason, text: input.text, sent: false,
    })
    try {
      // The same text refused again (its id is content-addressed) is undelivered
      // again, even if the user had sent the earlier copy by hand.
      if (!saveMessageIfAbsent(messageId, input.fromThreadId, 'system', content)) {
        rewriteSystemMarker(input.fromThreadId, messageId, PEER_UNDELIVERED_MARKER_PREFIX, () => content)
      }
    } catch (err) {
      log.warn(`failed to persist undelivered peer message ${messageId}: ${err}`)
    }
    this.publish({
      type: 'peer.undelivered', threadId: input.fromThreadId, messageId,
      peerThreadId: input.targetRoot, peerLabel: input.targetLabel, fromLabel: input.fromLabel,
      reason: input.reason, text: input.text, sent: false, notify: input.notify, at: Date.now(),
    })
  }

  /**
   * The user sent a kept message by hand: its row now says so, on every client.
   * Only when what was delivered is that row's message to that session, so a
   * client cannot mark a row sent by delivering something else.
   */
  private markUndeliveredSent(
    fromThreadId: string,
    messageId: string,
    delivered: { targetRoot: string; text: string; fromLabel: string },
  ): void {
    let rewritten: string | null = null
    try {
      rewritten = rewriteSystemMarker(fromThreadId, messageId, PEER_UNDELIVERED_MARKER_PREFIX, (content) => {
        const row = parseUndeliveredMarker(content)
        if (!row || row.to !== delivered.targetRoot || row.text !== delivered.text) return null
        return formatUndeliveredMarker({ ...row, sent: true })
      })
    } catch (err) {
      log.warn(`failed to mark undelivered peer message ${messageId} as sent: ${err}`)
    }
    const row = rewritten === null ? null : parseUndeliveredMarker(rewritten)
    if (!row) return
    this.publish({
      type: 'peer.undelivered', threadId: fromThreadId, messageId,
      peerThreadId: row.to, peerLabel: row.toLabel, fromLabel: delivered.fromLabel,
      reason: row.reason, text: row.text, sent: true, notify: false, at: Date.now(),
    })
  }

  /**
   * Why a prepared peer delivery must not go out after all, or null. Run after
   * the checkpoint await: the target may have stopped or switched profile, and
   * a linked send's link may have been removed (or replaced by a new one).
   */
  private peerDeliveryProblem(input: {
    targetThreadId: string
    adapter: ProviderAdapter
    targetLabel: string
    chargedEdge: number | null
    fromRoot: string
    targetRoot: string
  }): { reason: 'link-removed' | 'target-gone' | 'target-busy'; message: string } | null {
    if (input.chargedEdge !== null && this.peerLinks.edgeId(input.fromRoot, input.targetRoot) !== input.chargedEdge) {
      return {
        reason: 'link-removed',
        message: `The user removed the link with "${input.targetLabel}" while this message was being prepared. ${PEER_LINK_NOT_DELIVERED}`,
      }
    }
    if (this.sessionAdapters.get(input.targetThreadId) !== input.adapter || this.switchingSessions.has(input.targetThreadId)) {
      return {
        reason: 'target-gone',
        message: `"${input.targetLabel}" stopped or changed profiles before the message went out, so it was NOT delivered. Send it again once that session is running.`,
      }
    }
    // A turn may have started during the checkpoint await; an ACP agent would drop the send.
    if (speaksAcp(input.adapter.provider) && this.hasOutstandingTurn(input.targetThreadId)) {
      return {
        reason: 'target-busy',
        message: `"${input.targetLabel}" is mid-turn and cannot take a message yet. Try again when it finishes.`,
      }
    }
    return null
  }

  /** Remove one link, or every link of this session when `peerThreadId` is omitted. */
  unlinkPeers(threadId: string, peerThreadId?: string): PeerLinkView[] {
    const root = resolveRootThreadId(threadId)
    const peers = this.peerLinks.unlink(root, peerThreadId === undefined ? undefined : resolveRootThreadId(peerThreadId))
    if (peers.length > 0) {
      log.info(`peer link removed: ${root} <-> ${peers.join(', ')}`)
      this.announcePeerLinks([root, ...peers])
    }
    return this.listPeerLinks(threadId)
  }

  listPeerLinks(threadId: string): PeerLinkView[] {
    return this.peerLinks.linksOf(resolveRootThreadId(threadId))
      .map((link) => ({ ...link, title: this.sessionTitle(link.peerThreadId) }))
  }

  /** A stopped or archived session takes its links with it. */
  dropPeerLinks(threadId: string): void {
    const root = resolveRootThreadId(threadId)
    const peers = this.peerLinks.removeSession(root)
    if (peers.length === 0) return
    log.info(`peer links dropped with ${root}: ${peers.join(', ')}`)
    this.announcePeerLinks([root, ...peers])
  }

  /** The user typed in this session: every link it is on gets a fresh budget. */
  private renewPeerLinks(threadId: string): void {
    const root = resolveRootThreadId(threadId)
    const peers = this.peerLinks.humanMessage(root, Date.now())
    if (peers.length > 0) this.announcePeerLinks([root, ...peers])
  }

  private announcePeerLinks(threadIds: string[]): void {
    this.host.emit(ProviderChannels.PEER_LINKS_CHANGED, { threadIds })
  }

  async startManagedSession(opts: SessionStartOpts): Promise<ProviderSession> {
    if (!this.managedSessionStarter) throw new Error('Provider registry handlers are not ready.')
    return this.managedSessionStarter(opts)
  }

  async submitManagedUserTurn(input: UserTurnSubmissionV1): Promise<UserTurnSubmissionResult> {
    return this.submitAtomicUserTurn(input)
  }

  /**
   * Hand one live session's message to another on this backend.
   *
   * The ONE delivery path: the `/send-to` IPC handler calls it with
   * `initiator: 'user'` and the `send_agent_message` tool with
   * `initiator: 'agent'`. A second copy is how the guards, the approval gate or
   * the persistence would quietly diverge between the two.
   *
   * Delivery is an ordinary turn, which is what makes a peer message unable to
   * answer a pending approval: nothing here reaches `respondToRequest`.
   */
  async deliverPeerMessage(input: PeerMessageInput): Promise<{ id: string }> {
    const initiator = input.initiator ?? 'user'
    // `sessionAdapters` is keyed by whatever id startSession ran under, so
    // try the caller's id before the resolved root. Resolving first reported
    // a live chat as "not running" whenever its session id had rotated.
    // A "not delivered" row names its target by root id, so a session running
    // under another id of that root is found too.
    const targetThreadId = this.liveSessionId(input.targetThreadId) ?? resolveRootThreadId(input.targetThreadId)
    if (this.switchingSessions.has(targetThreadId)) {
      throw new Error('That session is changing profiles. Try again when it reconnects.')
    }
    this.beginPreparingTurn(targetThreadId)
    let preparationPending = true
    const releasePreparation = (): void => {
      if (!preparationPending) return
      preparationPending = false
      this.finishPreparingTurn(targetThreadId)
    }
    try {
    // The adapter cannot know its own conversation's title, so the agent path
    // omits it. Without the fallback the peer is told the message came from
    // `agent_1712`.
    const fromLabel = input.fromLabel
      ?? getConversationTitle(input.fromThreadId)
      ?? input.fromThreadId
    // Prefer the id the caller named: a stale resolved root often has no
    // title row, and falling back to it labelled the error with a raw id.
    const targetLabel = getConversationTitle(input.targetThreadId)
      ?? getConversationTitle(targetThreadId)
      ?? targetThreadId
    // A session messaging itself loops. The composer already excludes it, but
    // the model picks its target from a list and can misread its own id.
    if (
      targetThreadId === input.fromThreadId
      || resolveRootThreadId(input.fromThreadId) === resolveRootThreadId(targetThreadId)
    ) {
      throw new Error('That is this session. Pick one of the OTHER open sessions.')
    }
    const adapter = this.sessionAdapters.get(targetThreadId)
    if (!adapter) {
      throw new Error(`"${targetLabel}" is not running. Open it, then send again.`)
    }
    // An ACP agent is one prompt per turn and DROPS a mid-turn send, so
    // delivering into a running turn would record a message the agent never
    // saw. The other adapters queue or steer, so they are fine.
    if (speaksAcp(adapter.provider) && this.hasOutstandingTurn(targetThreadId)) {
      throw new Error(`"${targetLabel}" is mid-turn and cannot take a message yet. Try again when it finishes.`)
    }

    // Exact for the agent path: `fromThreadId` there is the id the adapter runs
    // its session under, which is the id a turn was recorded against.
    const senderDepth = this.turnDepth.get(input.fromThreadId) ?? 0
    const fromRoot = resolveRootThreadId(input.fromThreadId)
    const targetRoot = resolveRootThreadId(targetThreadId)
    // Before the link check, which would otherwise keep an oversized body as
    // a "not delivered" row the per-pair guard never got to refuse.
    const tooLarge = peerMessageTooLarge(input.text)
    if (tooLarge) throw new Error(tooLarge)
    // A send along a link the user made spends that edge's budget INSTEAD of
    // the hop depth and per-sender budget. Only along that edge: the same
    // session sending anywhere else still meets both.
    const linkVerdict = initiator === 'agent'
      ? this.peerLinks.checkSend(fromRoot, targetRoot, Date.now())
      : { linked: false as const }
    if (input.requireLink && !linkVerdict.linked) {
      throw new Error('The user removed the link with that session, so this message was not sent.')
    }
    if (linkVerdict.linked && !linkVerdict.ok) {
      log.warn(`linked peer send refused (${linkVerdict.reason}): ${input.fromThreadId} -> ${targetThreadId}`)
      this.recordUndelivered({
        fromThreadId: input.fromThreadId, fromLabel, targetRoot, targetLabel,
        text: input.text, reason: linkVerdict.reason, notify: linkVerdict.firstRefusal,
      })
      this.announcePeerLinks([fromRoot, targetRoot])
      throw new Error(linkVerdict.message)
    }
    // The edge this send was charged to. Checked again after the checkpoint
    // await: an unlink there, or an unlink and relink, is not the consent the
    // charge was made under.
    const chargedEdge = linkVerdict.linked ? this.peerLinks.edgeId(fromRoot, targetRoot) : null
    const releaseAgentSlot = (): void => {
      if (initiator !== 'agent') return
      if (chargedEdge !== null) this.peerLinks.release(fromRoot, targetRoot, chargedEdge)
      else this.peerAgentGuard.release(input.fromThreadId)
    }
    if (initiator === 'agent' && !linkVerdict.linked) {
      const agentVerdict = this.peerAgentGuard.check(
        { fromThreadId: input.fromThreadId, senderDepth },
        Date.now(),
      )
      if (!agentVerdict.ok) {
        log.warn(`agent peer send refused (${agentVerdict.reason}): ${input.fromThreadId} -> ${targetThreadId}`)
        throw new Error(agentVerdict.message)
      }
    }

    const key = { fromThreadId: input.fromThreadId, targetThreadId, text: input.text }
    const verdict = this.peerGuard.check(key, Date.now())
    if (!verdict.ok) {
      releaseAgentSlot()
      log.warn(`peer message refused (${verdict.reason}): ${input.fromThreadId} -> ${targetThreadId}`)
      throw new Error(verdict.message)
    }

    const body = wrapPeerMessage(fromLabel, input.text)
    // Same pre-turn bookkeeping an ordinary send does, or this turn's file
    // edits produce no diff cards and notebook mirrors go unwatched.
    const targetCwd = this.sessionCwd.get(targetThreadId)
    const targetWasMidTurn = this.hasOutstandingTurn(targetThreadId)
    if (targetCwd) await this.checkpoints.beginTurn(targetThreadId, targetCwd, targetWasMidTurn)
    // The only await before sendTurn: everything from here to it is
    // synchronous, so what this sees is what the send runs under.
    const withdrawn = this.peerDeliveryProblem({
      targetThreadId, adapter, targetLabel, chargedEdge, fromRoot, targetRoot,
    })
    if (withdrawn) {
      // A running turn keeps the checkpoint it now has; a fresh one belongs
      // to a turn that will not happen.
      // A turn that started meanwhile owns the checkpoint now.
      if (targetCwd && !targetWasMidTurn && withdrawn.reason !== 'target-busy') this.checkpoints.clear(targetThreadId)
      this.peerGuard.release(verdict.id, key)
      releaseAgentSlot()
      log.warn(`peer message withdrawn before delivery (${withdrawn.reason}): ${input.fromThreadId} -> ${targetThreadId}`)
      if (withdrawn.reason === 'link-removed') {
        this.recordUndelivered({
          fromThreadId: input.fromThreadId, fromLabel, targetRoot, targetLabel,
          text: input.text, reason: 'link-removed', notify: false,
        })
      }
      throw new Error(withdrawn.message)
    }
    notebookManager.beginTurn(targetThreadId)
    const startsNewProviderTurn = startsOwnProviderTurn(adapter.provider, this.hasOutstandingTurn(targetThreadId), undefined)
    if (startsNewProviderTurn) this.beginOutstandingTurn(targetThreadId)
    releasePreparation()
    // Set before the send, not after: the receiving model may call the peer
    // tool the moment its turn starts, and the depth has to already be there.
    const previousDepth = this.turnDepth.get(targetThreadId)
    this.turnDepth.set(targetThreadId, nextHopDepth(senderDepth, initiator))
    try {
      await adapter.sendTurn(targetThreadId, body)
    } catch (err) {
      if (startsNewProviderTurn) this.finishOutstandingTurn(targetThreadId)
      // The turn did NOT happen, so release the guard slot: otherwise an
      // identical retry is refused as a duplicate for the next 10 minutes.
      this.peerGuard.release(verdict.id, key)
      releaseAgentSlot()
      if (previousDepth === undefined) this.turnDepth.delete(targetThreadId)
      else this.turnDepth.set(targetThreadId, previousDepth)
      throw err
    }

    const at = Date.now()
    // The receiving turn is persisted under the message id so a redelivery
    // of the same id cannot double-post, and the sender keeps a marker so
    // its own transcript says where the message went, and who decided. The
    // displayBody keeps the wrapper out of the bubble after a reload,
    // matching the live one.
    try {
      saveMessageIfAbsent(
        verdict.id, targetThreadId, 'user', body, undefined,
        `From "${fromLabel}": ${input.text}`,
      )
      saveMessageIfAbsent(
        `peer_${verdict.id}`,
        input.fromThreadId,
        'system',
        `${peerSentMarkerPrefix(initiator)} ${fromLabel} → ${targetLabel}`,
      )
    } catch (err) {
      log.warn(`failed to persist peer message ${verdict.id}: ${err}`)
    }

    log.info(`peer message delivered ${verdict.id} by ${initiator}: ${input.fromThreadId} -> ${targetThreadId} chars=${input.text.length}`)
    this.publish({
      type: 'peer.message', threadId: input.fromThreadId, direction: 'sent', initiator,
      messageId: verdict.id, peerThreadId: targetThreadId, peerLabel: targetLabel,
      text: input.text, at,
    })
    this.publish({
      type: 'peer.message', threadId: targetThreadId, direction: 'received', initiator,
      messageId: verdict.id, peerThreadId: input.fromThreadId, peerLabel: fromLabel,
      text: input.text, at,
    })
    // A message the user sent along a link is a human message on that edge.
    if (linkVerdict.linked || (initiator === 'user' && this.peerLinks.renew(fromRoot, targetRoot, at))) {
      this.announcePeerLinks([fromRoot, targetRoot])
    }
    if (initiator === 'user' && input.undeliveredId) {
      this.markUndeliveredSent(input.fromThreadId, input.undeliveredId, { targetRoot, text: input.text, fromLabel })
    }
    return { id: verdict.id }
    } finally {
      releasePreparation()
    }
  }

  /**
   * The mode a chat's writes are judged by: the adapter's own record, which
   * applies a queued message's mode only when it starts, or the saved mode of
   * a chat whose session is not running (a card answered after a restart).
   */
  private chatRuntimeMode(threadId: string): RuntimeMode {
    const live = this.liveSessionId(threadId)
    if (live) return this.sessionAdapters.get(live)?.runtimeModeOf?.(live) ?? this.sessionDescriptors.get(live)?.runtimeMode ?? 'sandbox'
    try {
      const saved = getConversationRuntimeMode(resolveRootThreadId(threadId))
      return isRuntimeMode(saved) ? saved : 'sandbox'
    } catch (err) {
      log.warn(`could not read the saved runtime mode of ${threadId}`, err)
      return 'sandbox'
    }
  }

  /**
   * One of the MCP server's cards closed. Runs the write on an approval (with
   * every check after the card), records what happened as a system row in the
   * chat, and tells the agent unless the user chose quiet. The agent's turn is
   * Switchboard's: it leaves hop depth, session links and pending plans alone,
   * so a result can neither restart a peer chain nor stand in for the user.
   */
  private async reportAgentCard(card: AgentApprovalCard, close: ApprovalCardClose, response: HostWriteResponse): Promise<void> {
    const plan = card.plan
    const what = isPrWritePlan(plan) ? prWritePlanSummary(plan) : `the message to session ${plan.sessionId}`
    let outcome: ApprovalResultOutcome
    let text: string
    if (close.kind === 'approve') {
      try {
        const result = await this.runAgentWrite(card, response)
        outcome = result.isError ? 'failed' : 'done'
        text = result.content.map((c) => c.text).join('\n')
      } catch (err) {
        // The tools report refusals as results; a throw is a bug, and the agent still hears something it can act on.
        log.error(`running approved card ${card.requestId} threw`, err)
        outcome = 'failed'
        text = `Switchboard could not run ${what}: ${errorMessage(err)} It may or may not have been sent; tell the user rather than asking again.`
      }
    } else if (close.kind === 'deny') {
      outcome = close.wake ? 'declined' : 'dismissed'
      text = declinedResultText(what)
    } else if (close.kind === 'withdrawn') {
      outcome = 'withdrawn'
      text = `You withdrew ${what}. Nothing was sent.`
    } else {
      outcome = 'stopped'
      text = `The chat was stopped before the user answered, so ${what} was not sent.`
    }
    const delivery = await this.deliverApprovalResult(card, text, closeWakesAgent(close))
    const messageId = `apr_${card.requestId}`
    const content = formatApprovalResultMarker({
      requestId: card.requestId,
      title: card.hostWrite ? hostWriteTitle(card.hostWrite) : 'Message another session',
      outcome,
      text,
      delivery,
    })
    try {
      saveMessageIfAbsent(messageId, card.chatId, 'system', content)
    } catch (err) {
      log.warn(`failed to persist the result of approval card ${card.requestId}`, err)
    }
    this.publish({
      type: 'approval.result', threadId: this.liveSessionId(card.threadId) ?? card.threadId,
      messageId, requestId: card.requestId, content, at: Date.now(),
    })
  }

  private async runAgentWrite(card: AgentApprovalCard, response: HostWriteResponse) {
    const threadId = this.liveSessionId(card.threadId) ?? card.threadId
    const runtimeMode = (): RuntimeMode => this.chatRuntimeMode(card.threadId)
    const publish = (event: RuntimeEvent): void => this.publish(event)
    const plan = card.plan
    if (isPrWritePlan(plan)) {
      return runPrWritePlan({ threadId, chatId: card.chatId, runtimeMode, publish, pullRequests: agentPullRequestAccess() }, plan, response)
    }
    return runPeerSendPlan({ threadId, runtimeMode, publish, peers: this }, plan)
  }

  /**
   * Hand the agent its result: a new turn when it is idle, queued behind the
   * running turn when it is not, or held until the chat's session runs again.
   * Returns how it went, for the chat's row.
   */
  private async deliverApprovalResult(card: AgentApprovalCard, text: string, wake: boolean): Promise<ApprovalResultDelivery> {
    const body = approvalResultTurn({ requestId: card.requestId, toolName: card.toolName, text })
    const live = this.liveSessionId(card.threadId)
    // A profile switch or relocation is restarting the session: hold it, and
    // the move flushes it once it commits or rolls back (`flushHeldApprovalResults`).
    const running = live !== null && !this.switchingSessions.has(live) && !this.executionRoot?.isRelocating(live)
    const delivery = approvalResultDelivery({ wake, live: running, midTurn: live !== null && this.hasOutstandingTurn(live) })
    if (delivery === 'none') return 'none'
    if ((delivery === 'turn' || delivery === 'queue') && live && await this.sendApprovalResultTurn(live, body, card.requestId)) return delivery
    this.holdApprovalResult(card.chatId, card.requestId, body)
    return 'hold'
  }

  private holdApprovalResult(chatId: string, requestId: string, body: string): void {
    try {
      this.approvalStore.holdResult({ id: `apr_${requestId}`, chatId, body, at: Date.now() })
    } catch (err) {
      log.error(`could not keep the result of approval card ${requestId} for later; the agent will not hear about it`, err)
    }
  }

  /**
   * One result turn, with the bookkeeping an ordinary send does (checkpoint,
   * outstanding turn) and none of a human one: `turnDepth`, links and pending
   * plans are untouched. False when the adapter refused it.
   */
  private async sendApprovalResultTurn(threadId: string, body: string, requestId: string): Promise<boolean> {
    const adapter = this.sessionAdapters.get(threadId)
    if (!adapter) return false
    this.beginPreparingTurn(threadId)
    let preparing = true
    const release = (): void => {
      if (!preparing) return
      preparing = false
      this.finishPreparingTurn(threadId)
    }
    try {
      const midTurn = this.hasOutstandingTurn(threadId)
      const cwd = this.sessionCwd.get(threadId)
      if (!midTurn && cwd) await this.checkpoints.beginTurn(threadId, cwd)
      if (this.sessionAdapters.get(threadId) !== adapter) return false
      notebookManager.beginTurn(threadId)
      const delivery = midTurn ? 'queue' as const : undefined
      const startsNewProviderTurn = startsOwnProviderTurn(adapter.provider, this.hasOutstandingTurn(threadId), delivery)
      if (startsNewProviderTurn) this.beginOutstandingTurn(threadId)
      const queuedId = midTurn ? `apr_${requestId}` : undefined
      if (queuedId) this.queuedTurns.expect(queuedId, 'Switchboard: an approval result', Date.now())
      release()
      try {
        await adapter.sendTurn(threadId, body, undefined, undefined, delivery, queuedId)
      } catch (err) {
        if (startsNewProviderTurn) this.finishOutstandingTurn(threadId)
        log.warn(`approval result ${requestId} was not delivered to ${threadId}`, err)
        return false
      } finally {
        if (queuedId) this.queuedTurns.settle(queuedId)
      }
      log.info(`approval result ${requestId} delivered to ${threadId}${midTurn ? ' behind the running turn' : ''}`)
      return true
    } finally {
      release()
    }
  }

  /**
   * Results held while the chat was not running, delivered once its session
   * runs again: after a plain start, and after a profile switch or relocation
   * commits or rolls back. A no-op while one of those is still under way.
   */
  private async flushHeldApprovalResults(threadId: string): Promise<void> {
    if (!this.sessionAdapters.has(threadId) || this.switchingSessions.has(threadId) || this.executionRoot?.isRelocating(threadId)) return
    const chatId = resolveRootThreadId(threadId)
    let held
    try {
      held = this.approvalStore.takeHeldResults(chatId)
    } catch (err) {
      log.warn(`could not read held approval results for ${chatId}`, err)
      return
    }
    for (const result of held) {
      const requestId = result.id.replace(/^apr_/, '')
      if (!await this.sendApprovalResultTurn(threadId, result.body, requestId)) this.holdApprovalResult(chatId, requestId, result.body)
    }
  }

  private flushHeldApprovalResultsLater(threadId: string): void {
    this.flushHeldApprovalResults(threadId).catch((err) => log.warn(`held approval results for ${threadId} failed`, err))
  }

  /** The user stopped or archived the chat: its open cards close unanswered. */
  closeAgentCards(threadId: string): void {
    this.agentApprovals.closeChat(resolveRootThreadId(threadId))
  }

  /**
   * Give a starting session its Switchboard MCP server: a token bound to this
   * thread, and the tools built against this registry. A failure leaves the
   * agent without the tools rather than failing the session.
   */
  private async openSwitchboardMcp(threadId: string, provider: ProviderKind): Promise<SwitchboardMcpLaunch | null> {
    if (!this.switchboardMcp) return null
    const chatId = (): string => resolveRootThreadId(threadId)
    const runtimeMode = (): RuntimeMode => this.chatRuntimeMode(threadId)
    const publish = (event: RuntimeEvent): void => this.publish(event)
    try {
      return await this.switchboardMcp.open(threadId, () => [
        ...buildPrTools({
          threadId,
          chatId: chatId(),
          agentLabel: agentLabel(toAgentProvider(provider)),
          cwd: () => this.sessionDescriptors.get(threadId)?.cwd ?? null,
          runtimeMode,
          publish,
          approvals: this.agentApprovals,
          budget: this.agentWriteBudget,
          pullRequests: agentPullRequestAccess(),
        }),
        ...buildPrLinkTools({ threadId, chatId: chatId(), runtimeMode, publish, pullRequests: agentPullRequestAccess() }),
        ...buildPeerMcpTools({ threadId, chatId: chatId(), runtimeMode, publish, approvals: this.agentApprovals, peers: this }),
        ...buildApprovalMcpTools({ chatId: chatId(), approvals: this.agentApprovals }),
      ])
    } catch (err) {
      log.warn(`Switchboard MCP server unavailable for ${threadId}; starting without its tools`, err)
      return null
    }
  }

  /**
   * A mode applied from any client is saved on the conversation (what a phone
   * reads when it opens the chat) and announced, so the desktop's picker and
   * every phone's follow it. Only the desktop used to save its own changes, so
   * a phone's change, or a turn carrying one, left every other client showing
   * the old mode.
   */
  private announceRuntimeMode(threadId: string, mode: RuntimeMode): void {
    try {
      setConversationRuntimeMode(threadId, mode)
    } catch (err) {
      log.warn(`failed to save runtime mode ${mode} for ${threadId}`, err)
    }
    const identity = this.sessionIdentity.get(threadId)
    if (identity) this.publish({ ...identity, runtimeMode: mode })
  }

  /**
   * After a turn carrying a mode was handed to the adapter: announce the mode
   * the adapter now runs in, if it changed. A message the adapter held keeps
   * the running turn's mode, so its mode is remembered and announced when it
   * starts. An adapter that cannot report its mode announces nothing.
   */
  private announceTurnRuntimeMode(
    adapter: ProviderAdapter,
    threadId: string,
    before: RuntimeMode | undefined,
    requested: RuntimeMode | undefined,
    queuedId?: string,
  ): void {
    const after = adapter.runtimeModeOf?.(threadId)
    if (!requested || after === undefined) return
    if (after !== before) this.announceRuntimeMode(threadId, after)
    else if (queuedId && after !== requested && this.queuedTurns.get(threadId, queuedId)) {
      this.heldTurnModes.set(queuedId, { threadId, mode: requested })
    }
  }

  /**
   * A queued message's row is stored when it is queued, so one that leaves
   * the queue without running would read as sent. Its row becomes an error
   * row that keeps the text, here or, after a restart, at the next launch.
   */
  private trackQueuedRow(event: RuntimeEvent): void {
    if (!this.queuedRows || (event.type !== 'turn.queued' && event.type !== 'turn.dequeued')) return
    try {
      if (event.type === 'turn.queued') {
        this.queuedRows.record({
          messageId: event.messageId,
          conversationId: resolveRootThreadId(event.threadId),
          text: event.text ?? '',
          queuedAt: event.queuedAt ?? Date.now(),
        })
      } else if (event.reason !== 'dropped') {
        this.queuedRows.forget(event.messageId)
      } else {
        const notSent = this.queuedRows.markNotSent(event.messageId, 'stopped')
        // Already stored by markNotSent, so straight to the bus.
        if (notSent) this.bus.publish({ type: 'error', threadId: event.threadId, message: notSent.content.slice('Error: '.length) })
      }
    } catch (err) {
      log.warn(`could not track queued message ${event.messageId} on ${event.threadId}: ${errorMessage(err)}`)
    }
  }

  private sweepQueuedRowsFromEarlierLaunch(): void {
    if (!this.queuedRows) return
    try {
      const swept = this.queuedRows.sweepEarlierLaunches()
      if (swept.length > 0) log.warn(`${swept.length} queued message(s) never ran before the last exit; marked not sent`)
    } catch (err) {
      log.warn(`could not check for queued messages left by the last exit: ${errorMessage(err)}`)
    }
  }

  private publish(event: RuntimeEvent): void {
    if (event.type === 'turn.queued' || event.type === 'turn.dequeued' || event.type === 'turn.queue-held') {
      const observed = this.queuedTurns.observe(event, this.sessionAdapters.get(event.threadId)?.provider)
      if (observed.releasesOutstandingTurn) this.finishOutstandingTurn(event.threadId)
      event = observed.event
      this.trackQueuedRow(event)
    }
    // Persisted here, not in ChatPanel, which only exists when a desktop window
    // is attached - a phone on a headless server saw a 529 once and lost it on
    // reload. The `Error: ` prefix is load-bearing: `getSystemMarkerMessages`
    // matches on it to merge these back into a reloaded thread.
    if (event.type === 'error') {
      try {
        saveMessageIfAbsent(
          `error_${Date.now()}_${++this.savedMessageSeq}`,
          event.threadId,
          'system',
          `Error: ${event.message}`,
        )
      } catch (err) {
        log.warn(`failed to persist error card for ${event.threadId}: ${err}`)
      }
    }
    // Claude queues some notices and drops them without a transcript line, so
    // without this copy a notice shown live is gone after a reload. Stamped
    // with the event's time so the reload can pair it with a line if one exists.
    // Stored under the root conversation, where a rotated session id reads it.
    if (event.type === 'task.notification') {
      try {
        const conversationId = resolveRootThreadId(event.threadId)
        saveMessageIfAbsent(storedTaskNoticeId(conversationId, event.messageId), conversationId, 'user', taskNotificationText(event), undefined, undefined, event.at)
      } catch (err) {
        log.warn(`failed to persist task notice ${event.taskId} for ${event.threadId}: ${err}`)
      }
    }
    if (event.type === 'session') {
      try {
        updateConversationSessionId(event.threadId, event.sessionId)
        recordThreadSession(event.sessionId, event.threadId)
      } catch (err) {
        log.warn(`failed to persist provider session mapping ${event.threadId} -> ${event.sessionId}: ${err}`)
      }
    }
    // Last known status per thread. The registry published these and kept
    // nothing, so a client that was not listening at the time - the desktop,
    // for a chat the phone started - had no way to ever learn a session was
    // running. `listSessions` and the re-attach descriptor both read this.
    if (event.type === 'status') this.sessionStatus.set(event.threadId, event.status)
    if (event.type === 'session.provider') this.sessionIdentity.set(event.threadId, event)
    // Open cards a reconnecting or reloaded client can recover - see
    // `getPendingRequests`. `request.opened` / `question.asked` block the
    // turn until answered, so they are always closed explicitly. A
    // `plan.proposed` is NOT: ExitPlanMode is denied at once and the turn
    // ends normally on `turn.completed` while the plan still awaits the
    // user's Implement/Iterate decision - clearing on `turn.completed` would
    // discard a plan seconds after proposing it, before there is any chance
    // to recover it. A plan is cleared only once the user actually responds
    // - see `clearPendingPlans`, called from the `turnDepth` reset to 0 in
    // `submitAtomicUserTurn`'s `prepare` and the legacy `SEND_TURN` handler's
    // `dispatch`, the same point that marks a turn as human-initiated rather
    // than a peer message or a queued follow-up. It clears ONLY plans there
    // - a Codex steer or a `delivery: 'queue'` send can reach that point
    // while the running turn is still blocked on an open approval or
    // question, which must keep waiting for its own closing event.
    // The broker keeps its own cards (`getPendingRequests` asks it): they
    // outlive the turn and the session, which this record does not.
    if ((event.type === 'request.opened' && !AgentApprovalBroker.owns(event.requestId)) || event.type === 'question.asked' || event.type === 'plan.proposed') {
      this.addPendingRequest(event)
    }
    if (event.type === 'request.closed') this.resolvePendingRequest(event.threadId, event.requestId)
    if (event.type === 'question.answered') this.resolvePendingRequest(event.threadId, event.requestId)
    // The provider reporting it died means nothing on this thread can still
    // be waiting - a stale card must not survive that either.
    if (event.type === 'status' && (event.status === 'error' || event.status === 'stopped')) {
      this.expirePendingRequests(event.threadId, event.status === 'error'
        ? 'The agent stopped with an error before it was answered.'
        : 'The agent session ended before it was answered.')
    }
    if (event.type === 'context_window' && event.maxTokens && event.model) {
      const provider = this.sessionAdapters.get(event.threadId)?.provider
      if (provider) this.contextWindows.set(`${provider}\0${event.model}`, event.maxTokens)
    }
    this.bufferAssistantText(event)
    this.bufferToolCall(event)
    // A steer is not counted, but one that lands after the turn's last tool
    // step runs as a turn of its own. Its tool calls mark the chat busy again
    // until that turn's own turn.completed. Only tool.started: it happens
    // inside a turn and nowhere else, unlike content, which also carries
    // notices sent while the chat is idle.
    if (event.type === 'tool.started' && !this.hasOutstandingTurn(event.threadId)) this.beginOutstandingTurn(event.threadId)
    // A text-only one is marked by the adapter instead, and may start while a
    // queued message is still counted, so it counts whatever the total.
    if (event.type === 'status' && event.newTurn) this.beginOutstandingTurn(event.threadId)
    if (event.type === 'tool.started') this.checkpoints.noteToolStarted(event.threadId, event.toolId, event.toolName, event.input)
    if (event.type === 'tool.completed') this.checkpoints.noteToolCompleted(event.threadId, event.toolId, event.writtenPaths)
    if (event.type === 'turn.dequeued' && event.reason === 'started') this.checkpoints.startQueuedTurn(event.threadId)
    if (event.type === 'turn.completed') this.finishOutstandingTurn(event.threadId)
    this.bus.publish(event)
    if (event.type === 'turn.dequeued') {
      // A promoted message joins the running turn, whose mode stands.
      const held = this.heldTurnModes.get(event.messageId)
      this.heldTurnModes.delete(event.messageId)
      if (held && event.reason === 'started') this.announceRuntimeMode(held.threadId, held.mode)
    }

    // A turn just ended - diff the start-of-turn checkpoint against the
    // working tree and stream one file.edited event per changed file. Fire
    // and forget; the cards land right after the turn.completed marker.
    if (event.type === 'turn.completed') {
      this.flushTurnMirror(event.threadId, true)
      void this.emitFileEdits(event.threadId, Date.now())
    }

    // Provider-agnostic worktree-drift detection: all three adapters emit
    // tool.started and turn.completed through here (tool.completed is NOT
    // universal - claude never sends it), so the watcher defers command
    // checks to the thread's next event. Worktrees may live anywhere (nested
    // under .switchboard/, /tmp, userData) - `git worktree list` names them.
    if (event.type === 'tool.started') {
      void this.driftHook((watcher, cwd) =>
        watcher.onToolStarted(event.threadId, cwd, event.toolName, event.input), event.threadId)
    }
    if (event.type === 'turn.completed') {
      // A Follow clicked mid-turn waited for exactly this moment. Killing the
      // turn to satisfy the click would have been worse than the wait.
      const boundary = this.executionRoot?.onTurnBoundary(event.threadId)
      // A relocation queued for this boundary held any result answered meanwhile.
      if (boundary) void boundary.finally(() => this.flushHeldApprovalResultsLater(event.threadId))
      void this.driftHook((watcher, cwd) => watcher.onTurnCompleted(event.threadId, cwd), event.threadId)
    }
  }

  private readonly switchFirstEventSpans = new Map<string, { span: PerfSpan; startAt: number }>()
  private readonly firstEventSpans = new Map<string, PerfSpan>()
  private readonly firstContentSpans = new Map<string, PerfSpan>()
  private readonly firstTurnSent = new Set<string>()

  private beginFirstTurnTiming(threadId: string): PerfSpan | undefined {
    if (this.firstTurnSent.has(threadId)) return
    this.firstTurnSent.add(threadId)
    const span = perfSpan('turn.first-content', { thread: threadId })
    this.firstContentSpans.set(threadId, span)
    return span
  }

  private cancelFirstTurnTiming(threadId: string, span: PerfSpan | undefined, outcome: string): void {
    if (!span || this.firstContentSpans.get(threadId) !== span) return
    span.end({ outcome })
    this.firstContentSpans.delete(threadId)
    this.firstTurnSent.delete(threadId)
  }

  private publishAdapterEvent(
    event: RuntimeEvent,
    agentType: Exclude<AgentType, 'terminal'>,
    providerInstanceId: string | null,
  ): void {
    if (event.type === 'content' || event.type === 'error' || event.type === 'turn.completed') {
      this.firstContentSpans.get(event.threadId)?.end({ outcome: event.type })
      this.firstContentSpans.delete(event.threadId)
    }
    if (event.type === 'session') {
      try {
        recordConversationSegment({
          conversationId: event.threadId,
          provider: agentType,
          providerSessionId: event.sessionId,
          providerInstanceId,
        })
      } catch (err) {
        log.warn(`failed to persist typed provider segment ${event.threadId} -> ${event.sessionId}: ${err}`)
      }
      const descriptor = this.sessionDescriptors.get(event.threadId)
      if (descriptor) {
        this.sessionDescriptors.set(event.threadId, { ...descriptor, sessionId: event.sessionId })
      }
    }
    this.publish(event)
  }

  private async driftHook(
    run: (watcher: DriftWatcher, cwd: string) => Promise<import('@shared/provider-events').RuntimeWorktreeDriftEvent | null>,
    threadId: string
  ): Promise<void> {
    try {
      const cwd = this.sessionCwd.get(threadId)
      if (!cwd) return
      const event = await run(this.driftWatcher, cwd)
      if (!event) return
      // The check shells out to git and realpath, so it yields. A relocation
      // can commit in that window, and publishing now would suggest following
      // back to where the user just left. The result was computed against a
      // root this thread no longer has, so it is not evidence of anything.
      if (this.sessionCwd.get(threadId) !== cwd) {
        log.info(`dropping drift result for ${threadId} - the root moved while it was being checked`)
        return
      }
      log.info('worktree drift detected', { threadId, worktree: event.worktreePath, branch: event.branch })
      // The count and the chat's setting ride on the event, so a client
      // decides between the chip and the "off" line without asking.
      let follow: ConversationFollowSuggestions | null = null
      try {
        follow = recordConversationWorkedWorktrees(threadId, [cwd, event.worktreePath])
      } catch (err) {
        log.warn(`could not record worked worktrees for ${threadId}: ${errorMessage(err)}`)
      }
      this.bus.publish(follow
        ? {
            ...event,
            followSuggestions: follow.mode,
            followNoticeDismissed: follow.noticeDismissed,
            workedWorktrees: follow.workedWorktrees.length,
          }
        : event)
    } catch (err) {
      log.warn(`worktree drift detection failed for ${threadId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The conversation's worktree pointer moved (Follow / branch-picker swap):
   *  re-baseline drift detection so reverse drift stays detectable. */
  updateSessionCwd(threadId: string, cwd: string): void {
    if (!this.sessionCwd.has(threadId)) return
    this.sessionCwd.set(threadId, cwd)
    this.driftWatcher.onSessionMoved(threadId)
    // Re-root the notebook mirror system on the new tree, otherwise the
    // watcher stays on the abandoned worktree and diff-card filtering keys
    // off the old cwd.
    notebookManager.detach(threadId)
    void this.attachNotebooks(threadId, cwd)
  }

  /**
   * The committed execution root for a thread, as this backend sees it.
   *
   * `machineId` is taken from `SWITCHBOARD_MACHINE_ID` when the backend was
   * told its own identity, and otherwise echoes what the caller claimed. A
   * backend that does not know its own name cannot meaningfully refuse a
   * request for being on the wrong machine, and the preload routing table has
   * already sent the call to the machine that owns the thread. The check is
   * enforced where the identity is actually known.
   */
  private readExecutionRoot(threadId: string, claimedMachineId?: string): ExecutionRoot | null {
    const stored = getConversationExecutionRoot(threadId)
    if (!stored?.projectPath) return null
    return resolveExecutionRoot({
      // Realpath, because `resolveTarget` realpaths the target and the two
      // are compared. On macOS `/var` is a symlink to `/private/var`, so a
      // project under a temp dir compares unequal to itself and a move back
      // to the checkout is stored as a worktree pointer at the checkout.
      projectPath: realpathSyncOr(stored.projectPath),
      worktreePath: stored.worktreePath,
      worktreeBranch: stored.worktreeBranch,
      machineId: process.env.SWITCHBOARD_MACHINE_ID || claimedMachineId || LOCAL_MACHINE_ID,
      executionRootRevision: stored.revision,
    })
  }

  /** Notebook mirrors are rooted at the git toplevel because checkpoint diff
   *  relPaths are always toplevel-relative, even for subdir-rooted sessions. */
  private async attachNotebooks(threadId: string, cwd: string): Promise<void> {
    try {
      const root = await this.gitToplevel(cwd)
      notebookManager.attach(threadId, cwd, root)
    } catch (err) {
      log.warn(`notebook attach failed for ${threadId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async gitToplevel(cwd: string): Promise<string> {
    try {
      const { stdout } = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd })
      return stdout.trim() || cwd
    } catch {
      return cwd // not a git repo - root at the session folder
    }
  }

  private async listWorktrees(repoFolder: string, fresh = false): Promise<WorktreeRef[]> {
    const cached = this.worktreeCache.get(repoFolder)
    if (!fresh && cached && Date.now() - cached.at < 10_000) return cached.refs
    // Coalesce concurrent misses into one subprocess.
    if (cached?.inflight) return cached.inflight
    const inflight = (async () => {
      try {
        const { stdout } = await promisify(execFile)('git', ['worktree', 'list', '--porcelain'], {
          cwd: repoFolder,
          timeout: 5_000,
        })
        // Normalize once at the cache boundary - roots are stable for the TTL.
        const refs = await Promise.all(
          parseWorktreeList(stdout).map(async (wt) => ({ ...wt, path: await realpathOrAncestor(wt.path) }))
        )
        this.worktreeCache.set(repoFolder, { at: Date.now(), refs })
        return refs
      } catch (err) {
        // Negative cache: a non-git session folder must not spawn a failing
        // subprocess (and a warn line) per tool event.
        log.warn(`git worktree list failed for ${repoFolder}: ${err instanceof Error ? err.message : String(err)}`)
        this.worktreeCache.set(repoFolder, { at: Date.now(), refs: [] })
        return []
      }
    })()
    this.worktreeCache.set(repoFolder, { at: cached?.at ?? 0, refs: cached?.refs ?? [], inflight })
    return inflight
  }

  private async emitFileEdits(threadId: string, turnEndedAt: number): Promise<void> {
    try {
      // Notebook hygiene: checkpoint diffs the mirror system already covers
      // (mirror-path events, engine-performed .ipynb writes) are dropped -
      // the synthetic mirror events drained below are their card source.
      // Direct .ipynb edits that bypassed the mirror stay visible.
      const events = filterNotebookFileEdits(await this.checkpoints.finishTurn(threadId), (ev) =>
        notebookManager.explainsFileEdit(ev)
      )
      for (const ev of [...events, ...notebookManager.drainTurnEdits(threadId)]) {
        this.mirrorFileEdit(ev, turnEndedAt)
        this.bus.publish(ev)
      }
    } catch (err) {
      log.warn(`emitFileEdits failed for ${threadId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async submitAtomicUserTurn(input: UserTurnSubmissionV1): Promise<UserTurnSubmissionResult> {
    const threadId = input.threadId
    if (this.switchingSessions.has(threadId)) {
      return rejectedAtomicTurn('Session queue full while a profile switch is in progress')
    }
    // A queued relocation commits at the next turn boundary, so accepting a
    // new turn here would start it in the directory the user is leaving.
    if (this.executionRoot?.isRelocating(threadId)) {
      return rejectedAtomicTurn('This chat is moving to its worktree right now. Send again in a moment.')
    }
    if (this.executionRoot?.hasQueued(threadId)) {
      return rejectedAtomicTurn('This chat is moving to its worktree after the current turn. Send again once the move completes.')
    }
    const starting = this.startingSessions.get(threadId)
    if (starting) await starting
    if (this.switchingSessions.has(threadId)) {
      return rejectedAtomicTurn('Session queue full while a profile switch is in progress')
    }
    if (this.executionRoot?.isRelocating(threadId)) {
      return rejectedAtomicTurn('This chat is moving to its worktree right now. Send again in a moment.')
    }
    if (this.executionRoot?.hasQueued(threadId)) {
      return rejectedAtomicTurn('This chat is moving to its worktree after the current turn. Send again once the move completes.')
    }
    const adapter = this.sessionAdapters.get(threadId)
    if (!adapter) return rejectedAtomicTurn(`No session: ${threadId}`)
    const conversationId = resolveRootThreadId(threadId)
    if (!getConversationById(conversationId)) {
      return rejectedAtomicTurn('Conversation is not durably available yet. Retry this exact turn.')
    }

    const firstContentSpan = this.beginFirstTurnTiming(threadId)
    this.beginPreparingTurn(threadId)
    let preparationPending = true
    const releasePreparation = (): void => {
      if (!preparationPending) return
      preparationPending = false
      this.finishPreparingTurn(threadId)
    }
    try {
      log.info(`submitUserTurn ${threadId} chars=${input.providerText.length} mode=${input.runtimeMode ?? 'sandbox'} images=${input.images?.length ?? 0}`)
      const clientScope = currentBackendRequestContext()?.clientScope
        ?? hashClientScope('unscoped-local', 'backend-host-without-request-context')
      const result = await this.atomicTurnSubmission.submit(input, {
        clientScope,
        conversationId,
        prepare: async () => {
          if (this.switchingSessions.has(threadId)) {
            throw new TurnNotAcceptedError('Session queue full while a profile switch is in progress')
          }
          if (speaksAcp(adapter.provider) && this.hasOutstandingTurn(threadId) && input.delivery !== 'queue') {
            throw new TurnNotAcceptedError(`${agentLabel(toAgentProvider(adapter.provider))} is mid-turn and cannot take another message yet`)
          }
          try {
            const cwd = this.sessionCwd.get(threadId)
            if (cwd) await this.checkpoints.beginTurn(threadId, cwd, this.hasOutstandingTurn(threadId))
            notebookManager.beginTurn(threadId)
            this.turnDepth.set(threadId, 0)
            this.renewPeerLinks(threadId)
            // The user just responded, resolving any plan awaiting
            // Implement/Iterate - same as hop depth resetting. Only plans:
            // this `prepare` also runs for a Codex steer or a
            // `delivery: 'queue'` send while the running turn is still
            // blocked on an open approval or question, and those must keep
            // waiting for their own request.closed / question.answered.
            this.clearPendingPlans(threadId)
          } catch (error) {
            throw new TurnNotAcceptedError('turn preparation failed before provider dispatch', { cause: error })
          }
        },
        finalize: (turn) => this.withPendingHandoff(threadId, adapter, turn),
        dispatch: async (turn) => {
          // A queued message becomes a turn of its own once the running one
          // ends, so it counts; a Codex steer joins the running turn and does not.
          const startsNewProviderTurn = startsOwnProviderTurn(adapter.provider, this.hasOutstandingTurn(threadId), input.delivery)
          if (startsNewProviderTurn) this.beginOutstandingTurn(threadId)
          releasePreparation()
          // The chat row id every client already has for this message, which
          // is what a held message is listed, promoted and cancelled by.
          const queuedId = input.delivery === 'queue' ? echoMessageId(input.origin) : undefined
          if (queuedId) {
            this.queuedTurns.expect(queuedId, queuedTurnComposerText(turn.providerText, turn.displayBody, turn.pillsMeta), Date.now())
          }
          const modeBefore = adapter.runtimeModeOf?.(threadId)
          // A fork's pending summaries ride on this message. Not on a queued
          // one: it may be cancelled before it ever reaches the agent.
          const mergeBack = queuedId ? null : this.mergeBacks.claimForTurn(threadId)
          // After finalize, so a fork summary follows any handoff preamble.
          const providerText = mergeBack ? mergeBack.apply(turn.providerText) : turn.providerText
          try {
            await adapter.sendTurn(threadId, providerText, input.runtimeMode, input.images, input.delivery, queuedId)
          } catch (error) {
            mergeBack?.release()
            if (startsNewProviderTurn) this.finishOutstandingTurn(threadId)
            if (isDefiniteAdapterPreconditionFailure(error, threadId)) {
              throw new TurnNotAcceptedError(errorMessage(error), { cause: error })
            }
            throw error
          } finally {
            if (queuedId) this.queuedTurns.settle(queuedId)
          }
          try {
            this.announceTurnRuntimeMode(adapter, threadId, modeBefore, input.runtimeMode, queuedId)
          } catch (error) {
            // The turn ends ambiguous: the summaries stay pending, not held.
            mergeBack?.release()
            throw error
          }
          return mergeBack?.dispatched(providerText)
        },
      })
      if (result.state === 'rejected') this.cancelFirstTurnTiming(threadId, firstContentSpan, 'rejected')
      return result
    } catch (error) {
      this.cancelFirstTurnTiming(threadId, firstContentSpan, 'submission-error')
      throw error
    } finally {
      releasePreparation()
    }
  }

  /** Budget for a handoff to `provider` on this chat's pinned model, when its window is known. */
  private handoffMaxChars(provider: ProviderKind, rootId: string): number {
    const model = getConversationModel(rootId)
    return handoffBudgetChars(model ? this.contextWindows.get(`${provider}\0${model}`) : undefined)
  }

  /**
   * Prefix a turn with the chat's pending context handoff. Built here so
   * every client gets it, phones included, and the flag is consumed only in
   * the acceptance transaction. A client that already injected one (an older
   * desktop or Expo build) is left alone. A failed read sends the turn
   * without one and keeps the flag for the next turn.
   */
  private async withPendingHandoff(threadId: string, adapter: ProviderAdapter, turn: UserTurnSubmissionV1): Promise<UserTurnSubmissionV1> {
    if (turn.handoff || stripHandoffPreamble(turn.providerText) !== turn.providerText) return turn
    try {
      const rootId = resolveRootThreadId(threadId)
      const pendingFrom = getConversationPendingHandoff(rootId)
      if (!pendingFrom) return turn
      if (!isHandoffSource(pendingFrom)) {
        log.warn(`dropping pending handoff from an unknown provider on ${rootId}`)
        clearConversationPendingHandoff(rootId, pendingFrom)
        return turn
      }
      const { messages } = await loadConversationHistory(rootId, '')
      const plan = planTurnHandoff({
        messages,
        pendingFrom,
        target: toAgentProvider(adapter.provider),
        resumedNatively: adapter.resumedNativeSession?.(threadId) ?? false,
        maxChars: this.handoffMaxChars(adapter.provider, rootId),
      })
      log.info(`handoff ${rootId} from=${pendingFrom} to=${adapter.provider} chars=${plan.preamble?.length ?? 0}`)
      if (!plan.preamble) {
        // Nothing new to replay; left set, a later turn would replay itself.
        clearConversationPendingHandoff(rootId, pendingFrom)
        return turn
      }
      return {
        ...turn,
        providerText: `${plan.preamble}\n\n${turn.providerText}`,
        displayBody: turn.displayBody ?? turn.providerText,
        pillsMeta: turn.pillsMeta ?? {},
        handoff: { expectedFrom: pendingFrom, markerId: `handoff_${turn.origin}`, markerText: plan.markerText },
      }
    } catch (err) {
      log.warn(`could not build the pending handoff for ${threadId}; sending without it`, err)
      return turn
    }
  }

  /**
   * The visible conversation as a handoff preamble, for an adapter whose
   * native session could not be resumed. Leaves out the unanswered user
   * messages it is about to send as themselves.
   */
  private async portableHistory(threadId: string, provider: ProviderKind): Promise<string | null> {
    const rootId = resolveRootThreadId(threadId)
    const { messages } = await loadConversationHistory(rootId, '')
    return buildHandoffPreamble(answeredHistory(messages), { maxChars: this.handoffMaxChars(provider, rootId) })
  }

  registerIpcHandlers(): void {
    this.host.handle(ProviderChannels.IS_AVAILABLE, async (provider: ProviderKind) => {
      // On a remote VM, gray out the providers that don't run there.
      if (process.env.SWITCHBOARD_REMOTE && remoteBlockedProviderLabel(provider)) return false
      const adapter = this.getAdapter(provider)
      if (!adapter) return false
      return adapter.isAvailable()
    })

    this.host.handle(ProviderChannels.SUBMIT_USER_TURN, async (input: UserTurnSubmissionV1) =>
      this.submitAtomicUserTurn(input))
    this.host.handle(ProviderChannels.RESOLVE_USER_TURN, async (input: UserTurnResolutionV1) => {
      if (!this.atomicTurnSubmission.resolve) throw new Error('turn resolution is unavailable')
      const clientScope = currentBackendRequestContext()?.clientScope
        ?? hashClientScope('unscoped-local', 'backend-host-without-request-context')
      return this.atomicTurnSubmission.resolve(input, {
        clientScope,
        conversationId: resolveRootThreadId(input.threadId),
      })
    })

    // Proactive remote-auth preflight for the chat-open banner. `_threadId`
    // exists ONLY so the preload RoutingTable (which keys on args[0]) routes
    // the call to the machine the session is bound to - the check itself
    // never uses it. Locally there is nothing to preflight, so a non-remote
    // backend always reports logged in; the START_SESSION backstop below
    // still catches any race.
    this.host.handle(ProviderChannels.CHECK_REMOTE_AUTH, async (
      _threadId: string,
      agentType: Extract<AgentType, 'claude-code' | 'codex'>,
      remoteConfigDir?: string,
    ) => {
      if (!process.env.SWITCHBOARD_REMOTE) return { loggedIn: true }
      return await checkRemoteProviderAuth(agentType, remoteProviderConfigDir(agentType, remoteConfigDir))
    })

    const stopSession = async (threadId: string): Promise<StoppedSessionSnapshot | null> => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return null
      const stopSpan = perfSpan('provider.stop', { thread: threadId })
      try {
        await adapter.stopSession(threadId)
      } finally {
        stopSpan.end()
      }
      this.switchFirstEventSpans.get(threadId)?.span.end({ outcome: 'stopped-before-event' })
      this.switchFirstEventSpans.delete(threadId)
      this.firstEventSpans.get(threadId)?.end({ outcome: 'stopped-before-event' })
      this.firstEventSpans.delete(threadId)
      this.firstContentSpans.get(threadId)?.end({ outcome: 'stopped-before-content' })
      this.firstContentSpans.delete(threadId)
      this.firstTurnSent.delete(threadId)
      // stopSession is the adapter's drain boundary. Session-rotation events
      // remain valid through it, so snapshot only after it resolves.
      const descriptor = this.sessionDescriptors.get(threadId)
      const credentials = this.sessionCredentials.get(threadId)
      if (!descriptor || !credentials) {
        throw new Error('Provider stopped without a recoverable session snapshot')
      }
      this.sessionEpochs.delete(threadId)
      this.flushTurnMirror(threadId, false)
      this.sessionAdapters.delete(threadId)
      this.sessionCwd.delete(threadId)
      this.sessionStatus.delete(threadId)
      this.sessionIdentity.delete(threadId)
      for (const [id, held] of this.heldTurnModes) if (held.threadId === threadId) this.heldTurnModes.delete(id)
      this.sessionDescriptors.delete(threadId)
      this.sessionCredentials.delete(threadId)
      this.outstandingTurns.delete(threadId)
      this.queuedTurns.clear(threadId)
      this.turnDepth.delete(threadId)
      // Approval cards are not closed here: a profile switch or a relocation
      // restarts the session, and the cards are the chat's. A user stop closes them.
      this.switchboardMcp?.close(threadId)
      this.expirePendingRequests(threadId, 'The agent session restarted before it was answered.')
      this.checkpoints.clear(threadId)
      this.driftWatcher.onSessionStopped(threadId)
      notebookManager.detach(threadId)
      return {
        descriptor: { ...descriptor },
        credentials: {
          ...credentials,
          resolvedEnv: { ...credentials.resolvedEnv },
        },
      }
    }

    // ── Execution-root relocation ──────────────────────────────────
    //
    // Built here so it can reuse the SAME `stopSession`/`startSession`
    // closures the profile switch uses. Those are the adapter drain boundary
    // and the rollback path; reimplementing them for relocation would be
    // reimplementing their bugs too.
    //
    // A relocation handle carries the stopped snapshot, the source path and
    // the staged-event gate, so `attachProvider` can tell a forward move from
    // a rollback without the coordinator having to know either exists.
    type RelocationHandle = {
      snapshot: StoppedSessionSnapshot
      /** Where the provider was. Logging and diagnostics only - never a decision. */
      sourcePath: string
      gate: ProviderEventGate
      threadId: string
    }

    const gitWorktrees = new ExecFileGitWorktreeAdapter()

    const executionRootHost: ExecutionRootHost = {
      currentRoot: (threadId, machineId) => this.readExecutionRoot(threadId, machineId),
      sessionState: (threadId) => {
        const descriptor = this.sessionDescriptors.get(threadId)
        return {
          threadIsLive: this.sessionAdapters.has(threadId),
          starting: this.startingSessions.has(threadId),
          switchingProfile: this.switchingSessions.has(threadId),
          preparingTurn: this.preparingTurns.has(threadId),
          turnActive: this.hasOutstandingTurn(threadId) || this.sessionStatus.get(threadId) === 'running',
          provider: descriptor?.provider ?? 'unknown',
        }
      },
      resolveTarget: async (currentRoot, targetPath): Promise<TargetResolution> => {
        try {
          await access(targetPath)
        } catch {
          return { ok: false, code: 'target-missing', message: `${targetPath} no longer exists.` }
        }
        try {
          // Repository identity by normalized `--git-common-dir`, not by
          // string containment: a worktree lives outside its parent checkout
          // as often as inside it, so a prefix test answers the wrong
          // question in both directions.
          const [here, there] = await Promise.all([
            gitWorktrees.resolveRepository(currentRoot.projectPath),
            gitWorktrees.resolveRepository(targetPath),
          ])
          if (here.repositoryId !== there.repositoryId) {
            return {
              ok: false,
              code: 'different-repository',
              message: 'That directory belongs to a different repository.',
            }
          }
        } catch (err) {
          log.warn(`relocation target ${targetPath} is not a usable git worktree`, err)
          return { ok: false, code: 'different-repository', message: 'That directory is not a worktree of this repository.' }
        }
        // The branch comes from git, never from the client. A renderer label
        // can be stale by the time the transaction runs.
        const branch = await getCurrentBranch(targetPath).catch(() => null)
        const resolved = await realpathOrAncestor(targetPath)
        return { ok: true, path: resolved, branch }
      },
      detachProvider: async (threadId): Promise<ProviderHandle> => {
        const descriptor = this.sessionDescriptors.get(threadId)
        const sourcePath = descriptor?.cwd ?? this.sessionCwd.get(threadId) ?? ''
        const gate: ProviderEventGate = { state: 'staging', events: [] }
        this.relocationGates.set(threadId, gate)
        try {
          const snapshot = await stopSession(threadId)
          if (!snapshot) throw new Error('The provider session disappeared during relocation')
          return { snapshot, sourcePath, gate, threadId }
        } catch (err) {
          // Every exit from here that is not a handle must drop the gate, or
          // this thread's events are staged for the life of the process and
          // the chat looks dead while the provider is fine.
          this.relocationGates.delete(threadId)
          throw err
        }
      },
      attachProvider: async (opaque, path, mode) => {
        const handle = opaque as RelocationHandle
        const restoring = mode === 'restore'
        const opts: SessionStartOpts = {
          threadId: handle.threadId,
          provider: handle.snapshot.descriptor.provider,
          cwd: path,
          model: handle.snapshot.descriptor.model,
          runtimeMode: handle.snapshot.descriptor.runtimeMode,
          // The native thread id is what makes this a move rather than a
          // restart. Claude re-runs its own resume preflight against the new
          // cwd on the next query, and Codex re-sends the cwd on every turn.
          resumeSessionId: handle.snapshot.descriptor.sessionId,
          instanceId: handle.snapshot.credentials.instanceId,
          remoteConfigDir: handle.snapshot.credentials.remoteConfigDir,
        }
        try {
          if (restoring) {
            // A rollback must not replay events the target produced before it
            // failed: they describe a directory the user is not in.
            handle.gate.state = 'discarded'
            handle.gate.events.length = 0
            this.relocationGates.delete(handle.threadId)
            await startSession(opts, true, undefined, handle.snapshot.credentials)
            return { ok: true, continuity: 'preserved' }
          }
          await startSession(opts, false, handle.gate, handle.snapshot.credentials)
          return {
            ok: true,
            continuity: handle.snapshot.descriptor.sessionId ? 'preserved' : 'not-needed',
          }
        } catch (err) {
          if (!restoring) {
            handle.gate.state = 'discarded'
            handle.gate.events.length = 0
            this.relocationGates.delete(handle.threadId)
            await stopSession(handle.threadId).catch(() => null)
          }
          const message = err instanceof Error ? err.message : String(err)
          if (restoring) throw new Error(message)
          return { ok: false, code: 'target-start-failed', message }
        }
      },
      commitRoot: (threadId, path, branch) => {
        const conversationId = resolveRootThreadId(threadId)
        const raw = getConversationById(conversationId)?.project_path ?? null
        const projectPath = raw ? realpathSyncOr(raw) : null
        // A relocation back to the parent checkout is stored as a NULL
        // pointer, not as the project path repeated, so every existing reader
        // of `worktree_path` keeps its current meaning.
        const pointer = projectPath && samePath(path, projectPath) ? null : path
        return commitConversationExecutionRoot(conversationId, pointer, pointer ? branch : null)
      },
      commitRuntime: (threadId, path) => {
        this.updateSessionCwd(threadId, path)
        const gate = this.relocationGates.get(threadId)
        if (!gate) return
        this.relocationGates.delete(threadId)
        const descriptor = this.sessionDescriptors.get(threadId)
        const agentType = toAgentProvider(descriptor?.provider ?? 'claude')
        const instanceId = this.sessionCredentials.get(threadId)?.instanceId ?? null
        gate.state = 'flushing'
        // One at a time, like the profile switch: a staged event can itself
        // trigger a publish, and draining the array in place keeps ordering.
        while (gate.events.length > 0) {
          const event = gate.events.shift()
          if (event) this.publishAdapterEvent(event, agentType, instanceId)
        }
        gate.state = 'committed'
        // Still relocating here: held results are flushed once relocate() returns.
      },
      publish: (event) => { this.bus.publish(event) },
    }
    this.executionRoot = new ExecutionRootCoordinator(executionRootHost)

    this.host.handle(
      ProviderChannels.RELOCATE_EXECUTION_ROOT,
      async (request: RelocateExecutionRootRequest) => {
        if (!this.executionRoot) throw new Error('Execution-root coordinator is not ready')
        try {
          return await this.executionRoot.relocate(request)
        } finally {
          // Committed or rolled back, results answered during the move go out now.
          this.flushHeldApprovalResultsLater(request.threadId)
        }
      },
    )

    const startSession = async (
      initialOpts: SessionStartOpts,
      publishProviderIdentity = true,
      eventGate?: ProviderEventGate,
      credentialSnapshot?: ProviderCredentialSnapshot,
    ): Promise<ProviderSession> => {
      const startSpan = perfSpan('provider.start', { thread: initialOpts.threadId, provider: initialOpts.provider })
      try {
      let opts = { ...initialOpts }
      const adapter = this.getAdapter(opts.provider)
      if (!adapter) throw new Error(`Unknown provider: ${opts.provider}`)

      // Idempotent re-attach: a second client must share a completed or
      // in-flight provider start instead of spawning another adapter process.
      if (this.sessionAdapters.has(opts.threadId)) {
        log.info(`startSession ${opts.threadId} already live - re-attaching`)
        const live = this.sessionDescriptors.get(opts.threadId)
        const liveInstance = live?.instanceId ? getProviderInstanceFull(live.instanceId) : null
        this.publish({
          type: 'session.provider',
          threadId: opts.threadId,
          provider: live?.provider ?? opts.provider,
          instanceId: live?.instanceId ?? null,
          instanceName: liveInstance?.displayName ?? null,
        })
        return {
          ...live,
          threadId: opts.threadId,
          provider: live?.provider ?? opts.provider,
          // A descriptor captures startup state; the registry tracks the live
          // status so a client attaching mid-turn does not render the chat idle.
          status: this.sessionStatus.get(opts.threadId) ?? 'idle',
          runtimeMode: sessionDefaultsFor(opts.threadId, toAgentProvider(opts.provider), {
            runtimeMode: opts.runtimeMode,
          }, opts.cwd).runtimeMode,
          cwd: this.sessionCwd.get(opts.threadId) ?? live?.cwd ?? opts.cwd,
          createdAt: live?.createdAt ?? Date.now(),
        } satisfies ProviderSession
      }
      const existingStart = this.startingSessions.get(opts.threadId)
      if (existingStart) {
        log.info(`startSession ${opts.threadId} already starting - waiting`)
        return await existingStart
      }
      let resolveStart!: (session: ProviderSession) => void
      let rejectStart!: (reason: unknown) => void
      const startPromise = new Promise<ProviderSession>((resolve, reject) => {
        resolveStart = resolve
        rejectStart = reject
      })
      // Real failures are surfaced to the actual awaiter below; this only
      // stops Node's unhandledRejection warning for the promise stashed in
      // `startingSessions` before anyone has awaited it.
      void startPromise.catch((err) => {
        log.debug(`startSession ${opts.threadId} rejected (handled by the real awaiter)`, err)
      })
      this.startingSessions.set(opts.threadId, startPromise)
      let allocatedEpoch: number | null = null
      this.firstEventSpans.set(opts.threadId, perfSpan('provider.first-event', { thread: opts.threadId, provider: opts.provider, switching: !!eventGate }))
      try {

      // Remote backends support Claude Code and Codex. Reject maintenance-only
      // OpenCode with a readable message instead of a deep adapter failure.
      let remoteProviderConfig: string | null = null
      if (process.env.SWITCHBOARD_REMOTE) {
        const blocked = remoteBlockedProviderLabel(opts.provider)
        if (blocked) {
          throw new Error(`${blocked} is not available on remote machines; use Claude Code or Codex.`)
        }
        // Per-device login: resolve this VM's per-instance config dir and, if
        // it has no creds, fail with the provider-specific login command.
        if (opts.provider === 'claude' || opts.provider === 'codex') {
          const remoteAgentType = opts.provider === 'claude' ? 'claude-code' : 'codex'
          remoteProviderConfig = remoteProviderConfigDir(remoteAgentType, opts.remoteConfigDir)
          const prompt = await remoteProviderLoginPrompt(remoteAgentType, remoteProviderConfig)
          if (prompt) throw new Error(prompt)
        }
      }

      // Fill in whatever the client left unsaid from this conversation's own
      // stored state, then the machine default. Without this a chat reopened
      // from the phone silently restarted in sandbox with the default profile,
      // whatever the desktop had set on it.
      const defaults = sessionDefaultsFor(opts.threadId, toAgentProvider(opts.provider), {
        runtimeMode: opts.runtimeMode,
        model: opts.model,
        instanceId: opts.instanceId,
      }, opts.cwd)
      opts = { ...opts, ...defaults }

      log.info(`startSession ${opts.threadId} provider=${opts.provider} cwd=${opts.cwd} mode=${defaults.runtimeMode} instance=${defaults.instanceId ?? '(default)'}`)
      // Catch macOS TCC denials before the adapter spawns - otherwise the
      // SDK fails deep in the stack with cryptic EPERMs.
      await assertCwdReadable(opts.cwd)

      const agentType = toAgentProvider(opts.provider)
      // A desktop-routed remote session carries the local profile id plus a
      // sanitized remote config-dir basename. Do not replace that identity
      // with the remote DB's default row merely because the ids differ.
      const instance = credentialSnapshot || remoteProviderConfig
        ? null
        : resolveProviderInstance(agentType, opts.instanceId)
      const resolvedInstanceId = credentialSnapshot?.instanceId ?? instance?.id ?? opts.instanceId
      const resolvedInstanceName = credentialSnapshot?.instanceName
        ?? instance?.displayName
        ?? resolvedInstanceId
      const resolvedEnv = credentialSnapshot?.resolvedEnv ?? instance?.env ?? {}
      const resolvedOauthDir = credentialSnapshot?.resolvedOauthDir ?? instance?.oauthDir ?? null
      // Every known oauth_dir for this agent kind, so the adapter can find a
      // resumeable JSONL across profiles. Includes the default dir so env-mode
      // sessions (no oauth_dir) are discoverable too.
      const candidateOauthDirs = Array.from(new Set([
        ...listOauthDirsForAgent(agentType),
        agentType === 'codex' ? remoteProviderConfigDir('codex', undefined) : defaultClaudeDir(),
      ]))
      const enrichedOpts: SessionStartOpts = {
        ...opts,
        portableHistory: () => this.portableHistory(opts.threadId, opts.provider),
        instanceId: resolvedInstanceId,
        resolvedEnv,
        resolvedOauthDir,
        candidateOauthDirs,
      }
      // Remote: point the provider config env at its durable per-instance dir under this VM's $HOME.
      if (remoteProviderConfig) enrichedOpts.resolvedOauthDir = remoteProviderConfig
      // A catalog the picker already probed lets the first query be
      // reconciled before any live list exists. Cache only; never spawns.
      const knownModels = peekCatalog(agentType, resolvedInstanceId, opts.remoteConfigDir)
      if (knownModels?.length) enrichedOpts.knownModels = knownModels
      log.info(`startSession resolved instance=${instance?.id ?? '(none)'} oauthDir=${enrichedOpts.resolvedOauthDir ?? '(none)'} candidates=[${candidateOauthDirs.join(', ')}]`)

      // Only a *synchronous* session event fired during this startSession call
      // (Codex resume/fresh-thread confirmation) should override the id the
      // adapter itself resolved. Seeding this from opts.resumeSessionId - the
      // raw, unvalidated hint - clobbered Claude's resolved resume id (root
      // thread + typed-segment lookup) whenever no such event fired, which is
      // every Claude startSession: Claude only emits 'session' later, mid-turn.
      let latestSessionId: string | undefined
      const providerInstanceId = resolvedInstanceId ?? null
      const executionEpoch = ++this.nextSessionEpoch
      allocatedEpoch = executionEpoch
      this.sessionEpochs.set(opts.threadId, executionEpoch)
      const switchboardMcp = await this.openSwitchboardMcp(opts.threadId, opts.provider)
      if (switchboardMcp) enrichedOpts.switchboardMcp = switchboardMcp
      if (this.stopRequestedDuringStart.delete(opts.threadId)) throw new Error(SESSION_START_STOPPED)
      const session = await adapter.startSession(enrichedOpts, (event) => {
        if (this.sessionEpochs.get(opts.threadId) !== executionEpoch) return
        const switchTiming = this.switchFirstEventSpans.get(opts.threadId)
        switchTiming?.span.end({ event: event.type, startMs: performance.now() - switchTiming.startAt })
        this.switchFirstEventSpans.delete(opts.threadId)
        this.firstEventSpans.get(opts.threadId)?.end({ event: event.type })
        this.firstEventSpans.delete(opts.threadId)
        if (event.type === 'session') latestSessionId = event.sessionId
        if (eventGate?.state === 'staging' || eventGate?.state === 'flushing') {
          eventGate.events.push(event)
          return
        }
        if (eventGate?.state === 'discarded') return
        this.publishAdapterEvent(event, agentType, providerInstanceId)
      })
      if (resolvedInstanceId) session.instanceId = resolvedInstanceId
      if (latestSessionId) session.sessionId = latestSessionId
      // Tell every client which profile this thread now runs on. A rotation
      // done on one client would otherwise leave the others showing the old
      // one, since only this resolution knows what was actually picked.
      if (publishProviderIdentity) {
        this.publish({
          type: 'session.provider',
          threadId: opts.threadId,
          provider: opts.provider,
          instanceId: resolvedInstanceId ?? null,
          instanceName: resolvedInstanceName ?? null,
        })
      }
      this.sessionAdapters.set(opts.threadId, adapter)
      this.sessionCwd.set(opts.threadId, session.cwd)
      // Kept so `listSessions` can describe this session to a client that
      // connects later, rather than only to the one that started it.
      this.sessionDescriptors.set(opts.threadId, session)
      this.sessionCredentials.set(opts.threadId, {
        instanceId: resolvedInstanceId,
        instanceName: resolvedInstanceName,
        resolvedEnv: { ...enrichedOpts.resolvedEnv },
        resolvedOauthDir: enrichedOpts.resolvedOauthDir ?? null,
        remoteConfigDir: credentialSnapshot?.remoteConfigDir ?? opts.remoteConfigDir,
      })
      await this.attachNotebooks(opts.threadId, session.cwd)
      // A turn an earlier process was running when it stopped: its cards now.
      if (this.checkpoints.restoreEarlier(opts.threadId)) void this.emitFileEdits(opts.threadId, Date.now())
      trackAnalyticsEvent('session_started', { provider: opts.provider })
      // Stop arrived while the adapter was starting: stop what just came up
      // instead of letting the waiting turn run in it. Checked before the flush
      // below, so held approval results stay held for the next start.
      if (this.stopRequestedDuringStart.delete(opts.threadId)) {
        log.info(`startSession ${opts.threadId} stopped by the user during start`)
        await stopSession(opts.threadId)
        throw new Error(SESSION_START_STOPPED)
      }
      // Results of cards answered while the chat was not running. A start
      // inside a profile switch or relocation (gated, or a rollback) is
      // skipped here; that flow flushes once it settles.
      if (!eventGate) this.flushHeldApprovalResultsLater(opts.threadId)
      resolveStart(session)
      return session
      } catch (err) {
        this.switchFirstEventSpans.get(initialOpts.threadId)?.span.end({ outcome: 'start-error' })
        this.switchFirstEventSpans.delete(initialOpts.threadId)
        this.firstEventSpans.get(initialOpts.threadId)?.end({ outcome: 'start-error' })
        this.firstEventSpans.delete(initialOpts.threadId)
        if (allocatedEpoch !== null && this.sessionEpochs.get(initialOpts.threadId) === allocatedEpoch) {
          this.sessionEpochs.delete(initialOpts.threadId)
        }
        if (!this.sessionAdapters.has(initialOpts.threadId)) {
          this.switchboardMcp?.close(initialOpts.threadId)
        }
        rejectStart(err)
        throw err
      } finally {
        this.startingSessions.delete(opts.threadId)
        this.stopRequestedDuringStart.delete(opts.threadId)
      }
      } finally {
        startSpan.end()
      }
    }

    this.managedSessionStarter = (opts) => startSession(opts)

    this.host.handle(ProviderChannels.START_SESSION, startSession)

    this.host.handle(ProviderChannels.SWITCH_INSTANCE, async (
      threadId: string,
      input: ProviderInstanceSwitchRequest,
    ) => {
      const switchSpan = perfSpan('provider.switch', { thread: threadId })
      const switchTiming = { thread: threadId, stopMs: 0, compatibilityMs: 0, startMs: 0 }
      const firstEventSpan = perfSpan('provider.switch.first-event', switchTiming)
      let switched = false
      try {
      const descriptor = this.sessionDescriptors.get(threadId)
      const currentInstanceId = descriptor?.instanceId ?? null
      const failure = (
        code: string,
        message: string,
        rolledBack?: boolean,
        reportedInstanceId: string | null = currentInstanceId,
      ) => ({ ok: false as const, code, message, currentInstanceId: reportedInstanceId, ...(rolledBack === undefined ? {} : { rolledBack }) })

      if (!descriptor || !this.sessionAdapters.has(threadId)) {
        return failure('context-unavailable', 'This thread is not attached to a live provider session')
      }
      // A relocation shares this flow's snapshot, gate and rollback path, so
      // the two must exclude each other in BOTH directions. The coordinator
      // already refuses to start while a switch holds the thread.
      if (this.switchingSessions.has(threadId) || this.startingSessions.has(threadId) || this.preparingTurns.has(threadId) || this.hasOutstandingTurn(threadId) || this.sessionStatus.get(threadId) === 'running' || this.executionRoot?.isRelocating(threadId) || this.executionRoot?.hasQueued(threadId)) {
        return failure('busy', 'Stop the current turn before switching profile')
      }
      if (input.expectedCurrentInstanceId !== currentInstanceId) {
        return failure('stale-selection', 'The active profile changed on another client')
      }
      if (input.targetInstanceId === currentInstanceId) {
        const current = getProviderInstanceFull(input.targetInstanceId)
        return {
          ok: true as const,
          threadId,
          provider: descriptor.provider,
          previousInstanceId: currentInstanceId,
          instanceId: currentInstanceId,
          instanceName: current?.displayName ?? input.targetInstanceId,
          continuity: 'not-needed' as const,
        }
      }

      const agentType = toAgentProvider(descriptor.provider)
      const target = getProviderInstanceFull(input.targetInstanceId)
      const remoteTargetConfig = (agentType === 'claude-code' || agentType === 'codex') && process.env.SWITCHBOARD_REMOTE && input.targetRemoteConfigDir
        ? remoteProviderConfigDir(agentType, input.targetRemoteConfigDir)
        : null
      if (!remoteTargetConfig && (!target || !target.enabled || target.agentType !== agentType)) {
        return failure('invalid-instance', 'That profile is unavailable for this provider')
      }
      if (speaksAcp(descriptor.provider)) {
        return failure('unsupported-provider', `${agentLabel(agentType)} cannot preserve an existing thread across profile changes yet`)
      }

      // Claim the thread before any transcript migration can await. Otherwise
      // a second switch or a new turn can race the preflight and attach to the
      // provider session that is about to be stopped.
      this.switchingSessions.add(threadId)
      try {
      const oldCredentials = this.sessionCredentials.get(threadId)
      if (!oldCredentials) {
        return failure('context-unavailable', 'The live profile credentials are unavailable for a safe rollback')
      }
      let oldOpts: SessionStartOpts = {
        threadId,
        provider: descriptor.provider,
        cwd: descriptor.cwd,
        model: descriptor.model,
        runtimeMode: descriptor.runtimeMode,
        resumeSessionId: descriptor.sessionId,
        instanceId: currentInstanceId ?? undefined,
        remoteConfigDir: oldCredentials.remoteConfigDir,
      }
      const targetInstanceId = input.targetInstanceId
      const targetInstanceName = target?.displayName ?? input.targetInstanceName ?? targetInstanceId
      let targetOpts: SessionStartOpts = {
        ...oldOpts,
        instanceId: targetInstanceId,
        ...(input.targetRemoteConfigDir ? { remoteConfigDir: input.targetRemoteConfigDir } : {}),
      }
      const targetEventGate: ProviderEventGate = { state: 'staging', events: [] }
      const oldRemoteConfig = oldCredentials.remoteConfigDir && (agentType === 'claude-code' || agentType === 'codex')
        ? remoteProviderConfigDir(agentType, oldCredentials.remoteConfigDir)
        : null
      const codexDefaultDir = remoteProviderConfigDir('codex', undefined)
      const startFresh = input.onContextConflict === 'start-fresh'
        try {
          const stopStart = performance.now()
          const stopped = await stopSession(threadId)
          switchTiming.stopMs = performance.now() - stopStart
          if (!stopped) throw new Error('The source provider session disappeared during the switch')
          oldOpts = {
            ...oldOpts,
            resumeSessionId: stopped.descriptor.sessionId,
          }
          targetOpts = startFresh
            ? { ...targetOpts, resumeSessionId: undefined }
            : { ...targetOpts, resumeSessionId: stopped.descriptor.sessionId }
        } catch (stopError) {
          this.publish({ type: 'status', threadId, status: 'error' })
          return failure(
            'target-start-failed',
            stopError instanceof Error ? stopError.message : String(stopError),
            false,
          )
        }

        if (!startFresh && oldOpts.resumeSessionId) {
          const compatibilityStart = performance.now()
          const preparation = descriptor.provider === 'claude'
            ? await prepareClaudeProfileSwitch({
                sessionId: oldOpts.resumeSessionId,
                cwd: descriptor.cwd,
                fromDir: oldRemoteConfig ?? oldCredentials.resolvedOauthDir ?? defaultClaudeDir(),
                toDir: remoteTargetConfig ?? target?.oauthDir ?? defaultClaudeDir(),
              })
            : await prepareCodexProfileSwitch({
                sessionId: oldOpts.resumeSessionId,
                fromDir: oldRemoteConfig ?? oldCredentials.resolvedOauthDir ?? codexDefaultDir,
                toDir: remoteTargetConfig ?? target?.oauthDir ?? codexDefaultDir,
              })
          switchTiming.compatibilityMs = performance.now() - compatibilityStart
          if (!preparation.ok) {
            try {
              await startSession(oldOpts, true, undefined, oldCredentials)
              const conflict = preparation.reason === 'context-conflict' || preparation.reason === 'concurrent-modification'
              return failure(
                conflict ? 'context-conflict' : 'context-preparation-failed',
                preparation.detail,
                true,
              )
            } catch (rollbackError) {
              this.publish({ type: 'status', threadId, status: 'error' })
              return failure(
                'rollback-failed',
                `Context preparation failed: ${preparation.detail}. Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
                false,
                null,
              )
            }
          }
        }

        const continuity = startFresh
          ? 'degraded' as const
          : oldOpts.resumeSessionId ? 'preserved' as const : 'not-needed' as const
        try {
          const startStart = performance.now()
          this.switchFirstEventSpans.set(threadId, { span: firstEventSpan, startAt: startStart })
          const targetSession = await startSession(targetOpts, false, targetEventGate)
          switchTiming.startMs = performance.now() - startStart
          commitConversationProviderSwitch({
            conversationId: threadId,
            provider: agentType,
            providerInstanceId: targetInstanceId,
            providerSessionId: targetSession.sessionId ?? null,
            ...(startFresh ? { pendingHandoffFrom: agentType } : {}),
          })
        } catch (targetError) {
          targetEventGate.state = 'discarded'
          targetEventGate.events.length = 0
          await stopSession(threadId).catch((stopErr) => {
            log.warn(`cleanup stopSession(${threadId}) failed after a failed provider switch`, stopErr)
          })
          try {
            await startSession(oldOpts, true, undefined, oldCredentials)
            return failure(
              'target-start-failed',
              targetError instanceof Error ? targetError.message : String(targetError),
              true,
            )
          } catch (rollbackError) {
            this.publish({ type: 'status', threadId, status: 'error' })
            this.publish({
              type: 'session.provider',
              threadId,
              provider: descriptor.provider,
              instanceId: null,
              instanceName: null,
            })
            return failure(
              'rollback-failed',
              `Target failed: ${targetError instanceof Error ? targetError.message : String(targetError)}. Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              false,
              null,
            )
          }
        }

        targetEventGate.state = 'flushing'
        while (targetEventGate.events.length > 0) {
          const event = targetEventGate.events.shift()
          if (event) this.publishAdapterEvent(event, agentType, targetInstanceId)
        }
        targetEventGate.state = 'committed'
        switched = true

        this.publish({
          type: 'session.provider',
          threadId,
          provider: descriptor.provider,
          instanceId: targetInstanceId,
          instanceName: targetInstanceName,
        })
        return {
          ok: true as const,
          threadId,
          provider: descriptor.provider,
          previousInstanceId: currentInstanceId,
          instanceId: targetInstanceId,
          instanceName: targetInstanceName,
          continuity,
        }
      } finally {
        this.switchingSessions.delete(threadId)
        // Committed or rolled back, results answered during the switch go out now.
        this.flushHeldApprovalResultsLater(threadId)
      }
      } finally {
        switchSpan.end(switchTiming)
        if (!switched) {
          firstEventSpan.end({ outcome: 'not-switched' })
          if (this.switchFirstEventSpans.get(threadId)?.span === firstEventSpan) this.switchFirstEventSpans.delete(threadId)
        }
      }
    })

    this.host.handle(ProviderChannels.SEND_TURN, async (threadId: string, message: string, runtimeMode?: RuntimeMode, images?: Array<{ url: string; mimeType?: string }>, origin?: string): Promise<TurnAcceptanceResult | undefined> => {
      if (origin) {
        const result = await this.submitAtomicUserTurn({
          version: 1,
          threadId,
          origin,
          providerText: message,
          autoTitleText: message,
          runtimeMode: runtimeMode ?? undefined,
          images: images ?? undefined,
        })
        return legacyAcceptanceResult(result)
      }
      if (this.switchingSessions.has(threadId)) {
        // "queue full" intentionally classifies this as retryable in the
        // durable mobile outbox. The reservation has not crossed the provider
        // boundary and may safely be attempted after the switch commits.
        throw new TurnNotAcceptedError('Session queue full while a profile switch is in progress')
      }
      const starting = this.startingSessions.get(threadId)
      if (starting) await starting
      if (this.switchingSessions.has(threadId)) {
        throw new TurnNotAcceptedError('Session queue full while a profile switch is in progress')
      }
      this.beginPreparingTurn(threadId)
      let preparationPending = true
      const releasePreparation = (): void => {
        if (!preparationPending) return
        preparationPending = false
        this.finishPreparingTurn(threadId)
      }
      let firstContentSpan: PerfSpan | undefined
      try {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) {
        log.warn(`sendTurn ${threadId} - no adapter (session not started?)`)
        throw new Error(`No session: ${threadId}`)
      }
      const acceptedImages = validateUserMessageImages(images)
      firstContentSpan = this.beginFirstTurnTiming(threadId)
      log.info(`sendTurn ${threadId} chars=${message.length} mode=${runtimeMode ?? 'sandbox'} images=${acceptedImages?.length ?? 0}`)
      if (speaksAcp(adapter.provider) && this.hasOutstandingTurn(threadId)) {
        throw new TurnNotAcceptedError(`${agentLabel(toAgentProvider(adapter.provider))} is mid-turn and cannot take another message yet`)
      }
      const dispatch = async (): Promise<void> => {
        // These operations happen before the provider boundary. A failure here
        // is a definite rejection and may safely release the reservation.
        try {
          const cwd = this.sessionCwd.get(threadId)
          if (cwd) await this.checkpoints.beginTurn(threadId, cwd, this.hasOutstandingTurn(threadId))
          notebookManager.beginTurn(threadId)
          this.turnDepth.set(threadId, 0)
          this.renewPeerLinks(threadId)
          // The user just responded, resolving any plan awaiting
          // Implement/Iterate - same as hop depth resetting. Only plans:
          // this can also run as a Codex steer while the running turn is
          // still blocked on an open approval or question, and those must
          // keep waiting for their own request.closed / question.answered.
          this.clearPendingPlans(threadId)
        } catch (error) {
          throw new TurnNotAcceptedError('turn preparation failed before provider dispatch', { cause: error })
        }

        const startsNewProviderTurn = startsOwnProviderTurn(adapter.provider, this.hasOutstandingTurn(threadId), undefined)
        if (startsNewProviderTurn) this.beginOutstandingTurn(threadId)
        releasePreparation()
        const modeBefore = adapter.runtimeModeOf?.(threadId)
        try {
          await adapter.sendTurn(threadId, message, runtimeMode, acceptedImages)
        } catch (error) {
          if (startsNewProviderTurn) this.finishOutstandingTurn(threadId)
          // Once the provider call starts, a generic failure is ambiguous. It
          // must remain dispatching so a retry cannot execute the turn twice.
          throw error
        }
        this.announceTurnRuntimeMode(adapter, threadId, modeBefore, runtimeMode ?? undefined)
      }

      // Positional callers without an origin predate durable idempotency. Keep
      // that wire shape installable, but never route origin-bearing clients
      // through this compatibility writer.
      await dispatch()
      const messageId = `turn_${Date.now()}_${++this.savedMessageSeq}`
      try {
        saveMessageIfAbsent(
          messageId,
          threadId,
          'user',
          message,
          acceptedImages ? JSON.stringify(acceptedImages) : undefined,
        )
      } catch (error) {
        log.warn(`failed to persist originless compatibility turn for ${threadId}: ${error}`)
      }
      this.publish({
        type: 'user.message',
        threadId,
        text: message,
        images: acceptedImages,
        at: Date.now(),
      })
      return undefined
      } catch (error) {
        this.cancelFirstTurnTiming(threadId, firstContentSpan, 'submission-error')
        throw error
      } finally {
        releasePreparation()
      }
    })

    // A client asked, so the user typed it. `initiator` is forced rather than
    // read: honouring a claimed `'agent'` would let a client take the agent
    // path's budget while skipping the approval canUseTool gives it.
    this.host.handle(ProviderChannels.DELIVER_PEER_MESSAGE, async (input: PeerMessageInput) =>
      this.deliverPeerMessage({ ...input, initiator: 'user' }))
    this.host.handle(ProviderChannels.LINK_PEER, async (input: { threadId: string; peerThreadId: string; messages?: number; windowMs?: number }) =>
      this.linkPeers(input.threadId, input.peerThreadId, input.messages, input.windowMs))
    this.host.handle(ProviderChannels.EXTEND_PEER_LINK, async (input: { threadId: string; peerThreadId: string }) =>
      this.extendPeerLink(input.threadId, input.peerThreadId))
    this.host.handle(ProviderChannels.UNLINK_PEER, async (input: { threadId: string; peerThreadId?: string }) =>
      this.unlinkPeers(input.threadId, input.peerThreadId))
    this.host.handle(ProviderChannels.LIST_PEER_LINKS, async (input: { threadId: string }) =>
      this.listPeerLinks(input.threadId))

    // `live` says whether this backend had a turn to stop. A client whose
    // status says running after a resume gap clears it on `live: false`,
    // since no closing event will ever come for a turn that is not there.
    this.host.handle(ProviderChannels.INTERRUPT, async (threadId: string): Promise<{ live: boolean }> => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) {
        // A profile switch restarts the session itself; a Stop there is not
        // a cancel of the switch.
        if (this.startingSessions.has(threadId) && !this.switchingSessions.has(threadId)) this.stopRequestedDuringStart.add(threadId)
        return { live: false }
      }
      const live = this.hasOutstandingTurn(threadId) || this.sessionStatus.get(threadId) === 'running'
      await adapter.interruptTurn(threadId)
      return { live }
    })

    this.host.handle(ProviderChannels.SET_RUNTIME_MODE, async (threadId: string, mode: RuntimeMode) => {
      if (!isRuntimeMode(mode)) throw new Error(`Unknown runtime mode: ${String(mode)}`)
      // Saved even with no live session, so the chat starts in it next time.
      await this.sessionAdapters.get(threadId)?.setRuntimeMode(threadId, mode)
      this.announceRuntimeMode(threadId, mode)
    })

    this.host.handle(ProviderChannels.SET_MODEL, async (threadId: string, model: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      if (adapter.setModel) await adapter.setModel(threadId, model)
    })

    this.host.handle(ProviderChannels.SET_REASONING_EFFORT, async (threadId: string, effort: string) => {
      if (!isReasoningEffort(effort)) throw new Error(`Unknown reasoning effort: ${String(effort)}`)
      await this.sessionAdapters.get(threadId)?.setReasoningEffort?.(threadId, effort)
    })

    // An answer to a request the provider no longer waits on is refused, so
    // the card shows an error rather than hanging on "Submitting...".
    this.host.handle(ProviderChannels.ANSWER_QUESTION, async (threadId: string, requestId: string, answers: string[][]) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter || !this.holdsPendingRequest(threadId, requestId)) throw new Error(REQUEST_EXPIRED)
      if (adapter.answerQuestion) await adapter.answerQuestion(threadId, requestId, answers)
    })

    this.host.handle(ProviderChannels.RESPOND_TO_REQUEST, async (threadId: string, requestId: string, decision: ApprovalDecision, response?: unknown) => {
      if (AgentApprovalBroker.owns(requestId)) {
        // A device that may send the agent turns (the chat scope, which a
        // phone has) may approve the post it asked for: the card shows the
        // text, and a full-access turn is the larger power. Only an admin
        // device may change that text, so a phone's approval posts the draft
        // it showed, and must prove it showed all of it (`shown`). The Reviews
        // write channels stay admin-scoped in device-auth.
        const parsed = parseHostWriteResponse(response)
        const mayEdit = remoteDeviceHasScope('admin')
        const answer = this.agentApprovals.respond(threadId, requestId, decision, mayEdit ? parsed : approvalChoiceOnly(parsed), {
          mayApproveHostWrite: remoteDeviceHasScope('chat'),
          mustProveShown: !mayEdit,
          label: describeRequestClient(),
        })
        if (!answer.ok) throw new Error(answer.message)
        return
      }
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter || !this.holdsPendingRequest(threadId, requestId)) throw new Error(REQUEST_EXPIRED)
      await adapter.respondToRequest(threadId, requestId, decision)
    })

    this.host.handle(ProviderChannels.LIST_SKILLS, async (threadId: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter?.listSkills) return []
      try {
        return await adapter.listSkills(threadId)
      } catch (err) {
        log.warn(`listSkills failed for ${threadId}: ${err}`)
        return []
      }
    })

    this.host.handle(ProviderChannels.LIST_CATALOG, async (req: { threadId?: string; agentType: string; instanceId?: string | null; remoteConfigDir?: string }) => {
      if (!isAgentProvider(req?.agentType)) return []
      // The probe starts the real CLI with this machine's credentials, so the
      // demo adapter's recordings and screenshots would list whatever models
      // that account has. Empty means the picker's built-in list.
      if (process.env.SB_DEMO_ADAPTER === '1') return []
      return probeCatalog(req.agentType, req.instanceId, req.remoteConfigDir)
    })

    this.host.handle(ProviderChannels.LIST_MODELS, async (threadId: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter?.listModels) return null
      try {
        return await adapter.listModels(threadId)
      } catch (err) {
        log.warn(`listModels failed for ${threadId}: ${err}`)
        return null
      }
    })

    // What is running here, for a client that was not connected when it
    // started. Without this the desktop could never learn about a session the
    // phone began: events are broadcast live, never replayed from before the
    // session existed, and every store reducer no-ops on an unknown threadId.
    this.host.handle(ProviderChannels.LIST_SESSIONS, () => this.listSessions())

    // A thread's still-open approval/question/plan cards - see
    // `getPendingRequests`. Not gated on a live adapter: the whole point is
    // recovering a card after the process that opened it may be long gone
    // from this client's view (reload, resume gap).
    this.host.handle(ProviderChannels.GET_PENDING_REQUESTS, (threadId: string) => this.getPendingRequests(threadId))

    this.host.handle(ProviderChannels.MERGE_BACK_PREVIEW, (forkThreadId: string) => this.mergeBacks.preview(forkThreadId))
    this.host.handle(ProviderChannels.MERGE_BACK_SEND, (forkThreadId: string, text: unknown, token: unknown) =>
      this.mergeBacks.send(forkThreadId, text, token))
    this.host.handle(ProviderChannels.MERGE_BACK_EDIT, async (parentThreadId: string, mergeBackId: string, text: unknown) =>
      this.mergeBacks.edit(parentThreadId, mergeBackId, text))
    this.host.handle(ProviderChannels.MERGE_BACK_DISCARD, async (parentThreadId: string, mergeBackId: string) =>
      this.mergeBacks.discard(parentThreadId, mergeBackId))
    this.host.handle(ProviderChannels.LIST_QUEUED_TURNS, (threadId: string) => this.listQueuedTurns(threadId))
    this.host.handle(ProviderChannels.RESUME_QUEUED_TURNS, (threadId: string) => this.resumeQueuedTurns(threadId))
    this.host.handle(ProviderChannels.PROMOTE_QUEUED_TURN, (threadId: string, messageId: string) =>
      this.actOnQueuedTurn('promote', threadId, messageId))
    this.host.handle(ProviderChannels.CANCEL_QUEUED_TURN, (threadId: string, messageId: string) =>
      this.actOnQueuedTurn('cancel', threadId, messageId))

    // A user stop is deliberate: a relocation waiting for a turn that will
    // never arrive must not fire against the next session on this thread.
    this.host.handle(ProviderChannels.STOP_SESSION, async (threadId: string) => {
      this.executionRoot?.onSessionStopped(threadId)
      this.dropPeerLinks(threadId)
      this.closeAgentCards(threadId)
      const starting = this.startingSessions.get(threadId)
      if (starting && !this.sessionAdapters.has(threadId) && !this.switchingSessions.has(threadId)) {
        this.stopRequestedDuringStart.add(threadId)
        // The start stops its own session once it exists; wait for that.
        await starting.catch((err) => log.info(`stop of ${threadId} during start: ${err instanceof Error ? err.message : String(err)}`))
        return null
      }
      return await stopSession(threadId)
    })

    log.info('IPC handlers registered')
  }

  async stopAll(): Promise<void> {
    for (const { span } of this.switchFirstEventSpans.values()) span.end({ outcome: 'shutdown' })
    this.switchFirstEventSpans.clear()
    for (const span of this.firstEventSpans.values()) span.end({ outcome: 'shutdown' })
    for (const span of this.firstContentSpans.values()) span.end({ outcome: 'shutdown' })
    this.firstEventSpans.clear()
    this.firstContentSpans.clear()
    this.firstTurnSent.clear()
    // Open approval cards stay in the store: a quit or a closed window is not an answer.
    for (const threadId of this.sessionAdapters.keys()) this.switchboardMcp?.close(threadId)
    for (const [threadId, adapter] of this.sessionAdapters) {
      await adapter.stopSession(threadId).catch((err) => {
        log.warn(`stopSession failed for ${threadId}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    this.sessionAdapters.clear()
    this.sessionCwd.clear()
    this.sessionEpochs.clear()
    if (this.rendererUnsub) {
      this.rendererUnsub()
      this.rendererUnsub = null
    }
    this.bus.clear()
  }
}

/** Last-constructed registry, for callers without a reference (ipc/app.ts's
 *  worktree-swap handler re-baselines drift detection through this). */
let activeRegistry: ProviderRegistry | null = null

export function notifyWorktreeSwap(threadId: string, cwd: string | null): void {
  if (cwd) activeRegistry?.updateSessionCwd(threadId, cwd)
}

/** An archived conversation loses its session links (ipc/app.ts's archive handler). */
export function notifyConversationArchived(conversationId: string): void {
  activeRegistry?.dropPeerLinks(conversationId)
  activeRegistry?.closeAgentCards(conversationId)
}

/**
 * Fan an event that no adapter produced out to every client.
 *
 * The bus is the only path that reaches the registry's MultiHost, so this is
 * what gets a broadcast to the renderer AND every paired phone at once. Skips
 * the registry's own `publish()` on purpose: that layer adds session-id
 * persistence and post-turn diffing, neither of which applies here.
 */
export function publishRuntimeEvent(event: RuntimeEvent): void {
  if (!activeRegistry) {
    log.warn(`no active registry - dropping ${event.type} for ${event.threadId}`)
    return
  }
  activeRegistry.bus.publish(event)
}
