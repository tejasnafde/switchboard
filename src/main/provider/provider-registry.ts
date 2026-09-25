/**
 * Provider registry - manages adapter instances and routes operations.
 */

import type { BackendHost } from '../backend/host'
import { AppChannels, ProviderChannels } from '@shared/ipc-channels'
import { applyContentText } from '@shared/content-stream'
import { createMainLogger as createLogger } from '../logger'
import { trackAnalyticsEvent } from '../analytics'
import { ClaudeAdapter } from './adapters/claude-adapter'
import { CodexAdapter } from './adapters/codex-adapter'
import { demoAdapters } from './adapters/demo-adapter'
import { OpencodeAcpAdapter } from './adapters/opencode-acp-adapter'
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
import { CheckpointTracker } from './checkpoint-tracker'
import { notebookManager } from '../notebooks/manager'
import { filterNotebookFileEdits } from '../notebooks/file-edit-filter'
import { getProviderInstanceFull, resolveProviderInstance, listOauthDirsForAgent } from '../db/provider-instances'
import { commitConversationProviderSwitch, deleteUserMessage, recordConversationWorkedWorktrees, type ConversationFollowSuggestions, recordConversationSegment, recordThreadSession, updateConversationSessionId, saveMessageIfAbsent, saveActivityMessageIfAbsent, setConversationStatusLine, getConversationById, getConversationTitle, resolveRootThreadId, getDb, getConversationExecutionRoot, commitConversationExecutionRoot } from '../db/database'
import { SqliteTurnAcceptanceStore } from '../db/turn-acceptance'
import { currentBackendRequestContext, hashClientScope } from '../backend/request-context'
import {
  AtomicUserTurnSubmission,
  DurableTurnAcceptance,
  TurnNotAcceptedError,
  type TurnAcceptanceResult,
} from './durable-turn-acceptance'
import { sessionDefaultsFor } from './session-defaults'
import { QueuedTurnLedger } from './queued-turn-ledger'
import { queuedTurnComposerText } from '@shared/queued-turns'
import { echoMessageId } from '@shared/provider-events'
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
  peerSentMarkerPrefix,
  wrapPeerMessage,
  type PeerMessageInput,
} from '@shared/peer-messaging'
import type { PeerSessionSummary, PeerToolHost } from './peer-tools'
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
import { isAgentProvider, toAgentProvider } from '@shared/types'
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
  private opencodeAcp: OpencodeAcpAdapter
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
  private checkpoints = new CheckpointTracker()
  private readonly atomicTurnSubmission: Pick<AtomicUserTurnSubmission, 'submit'> & Partial<Pick<AtomicUserTurnSubmission, 'resolve'>>
  /** Provider startup shared by every client that reaches a thread before its adapter exists. */
  private startingSessions = new Map<string, Promise<ProviderSession>>()
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
  ) {
    activeRegistry = this
    this.host = host
    this.opencodeAcp = new OpencodeAcpAdapter()
    // SB_DEMO_ADAPTER=1 swaps in the scripted adapter so the tour recorder
    // (videos/capture-tour.mjs) can capture agent-driven scenes without
    // credentials. Never set by a normal launch.
    this.adapters = adapters ?? (process.env.SB_DEMO_ADAPTER === '1'
      ? demoAdapters()
      : new Map<ProviderKind, ProviderAdapter>([
        ['claude', new ClaudeAdapter()],
        ['codex', new CodexAdapter()],
        ['opencode', this.opencodeAcp],
      ]))
    const turnStore = new SqliteTurnAcceptanceStore(() => getDb())
    this.atomicTurnSubmission = atomicTurnSubmission ?? new AtomicUserTurnSubmission({
      store: turnStore,
      publish: (event) => this.publish(event),
    })
    this.bus = new RuntimeEventBus()
    this.rendererUnsub = this.bus.subscribe((event) => this.forwardToRenderer(event))
    // Lets an adapter expose the peer tools to its model. Only the Claude
    // adapter implements it; the others stay valid targets that cannot send.
    for (const adapter of this.adapters.values()) adapter.setPeerToolHost?.(this)
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
   * Hop depth of each thread's current turn - how many consecutive
   * agent-initiated peer messages stand between it and a human message.
   *
   * Deliberately NOT cleared at turn end. A session that acted on a peer
   * message stays at that depth until the user speaks to it again, so an
   * unattended chain cannot continue past the limit by waiting a turn.
   */
  private turnDepth = new Map<string, number>()

  /** Accepted turns not yet matched by a turn.completed event. This is a
   * count, not a boolean: Claude accepts a second prompt into its queue before
   * the first completes, and a profile switch must wait for both. */
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
    const byKey = this.pendingRequests.get(resolveRootThreadId(threadId))
    return byKey ? [...byKey.values()] : []
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
      })
    }
    return out
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
    const targetThreadId = this.sessionAdapters.has(input.targetThreadId)
      ? input.targetThreadId
      : resolveRootThreadId(input.targetThreadId)
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
    // OpenCode ACP is one prompt per turn and DROPS a mid-turn send, so
    // delivering into a running turn would record a message the agent never
    // saw. The other adapters queue or steer, so they are fine.
    if (adapter.provider === 'opencode' && this.hasOutstandingTurn(targetThreadId)) {
      throw new Error(`"${targetLabel}" is mid-turn and cannot take a message yet. Try again when it finishes.`)
    }

    // Exact for the agent path: `fromThreadId` there is the id the adapter runs
    // its session under, which is the id a turn was recorded against.
    const senderDepth = this.turnDepth.get(input.fromThreadId) ?? 0
    if (initiator === 'agent') {
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
      if (initiator === 'agent') this.peerAgentGuard.release(input.fromThreadId)
      log.warn(`peer message refused (${verdict.reason}): ${input.fromThreadId} -> ${targetThreadId}`)
      throw new Error(verdict.message)
    }

    const body = wrapPeerMessage(fromLabel, input.text)
    // Same pre-turn bookkeeping an ordinary send does, or this turn's file
    // edits produce no diff cards and notebook mirrors go unwatched.
    const targetCwd = this.sessionCwd.get(targetThreadId)
    if (targetCwd) await this.checkpoints.beginTurn(targetThreadId, targetCwd)
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
      if (initiator === 'agent') this.peerAgentGuard.release(input.fromThreadId)
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
    return { id: verdict.id }
    } finally {
      releasePreparation()
    }
  }

  private publish(event: RuntimeEvent): void {
    if (event.type === 'turn.queued' || event.type === 'turn.dequeued') {
      const observed = this.queuedTurns.observe(event, this.sessionAdapters.get(event.threadId)?.provider)
      if (observed.releasesOutstandingTurn) this.finishOutstandingTurn(event.threadId)
      event = observed.event
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
    if (event.type === 'request.opened' || event.type === 'question.asked' || event.type === 'plan.proposed') {
      this.addPendingRequest(event)
    }
    if (event.type === 'request.closed') this.resolvePendingRequest(event.threadId, event.requestId)
    if (event.type === 'question.answered') this.resolvePendingRequest(event.threadId, event.requestId)
    // The provider reporting it died means nothing on this thread can still
    // be waiting - a stale card must not survive that either.
    if (event.type === 'status' && (event.status === 'error' || event.status === 'stopped')) {
      this.pendingRequests.delete(event.threadId)
    }
    this.bufferAssistantText(event)
    this.bufferToolCall(event)
    if (event.type === 'turn.completed') this.finishOutstandingTurn(event.threadId)
    this.bus.publish(event)

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
      void this.executionRoot?.onTurnBoundary(event.threadId)
      void this.driftHook((watcher, cwd) => watcher.onTurnCompleted(event.threadId, cwd), event.threadId)
    }
  }

  private publishAdapterEvent(
    event: RuntimeEvent,
    agentType: Exclude<AgentType, 'terminal'>,
    providerInstanceId: string | null,
  ): void {
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
      return await this.atomicTurnSubmission.submit(input, {
        clientScope,
        conversationId,
        prepare: async () => {
          if (this.switchingSessions.has(threadId)) {
            throw new TurnNotAcceptedError('Session queue full while a profile switch is in progress')
          }
          if (adapter.provider === 'opencode' && this.hasOutstandingTurn(threadId) && input.delivery !== 'queue') {
            throw new TurnNotAcceptedError('OpenCode is mid-turn and cannot take another message yet')
          }
          try {
            const cwd = this.sessionCwd.get(threadId)
            if (cwd) await this.checkpoints.beginTurn(threadId, cwd)
            notebookManager.beginTurn(threadId)
            this.turnDepth.set(threadId, 0)
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
        dispatch: async () => {
          // A queued message becomes a turn of its own once the running one
          // ends, so it counts; a Codex steer joins the running turn and does not.
          const startsNewProviderTurn = startsOwnProviderTurn(adapter.provider, this.hasOutstandingTurn(threadId), input.delivery)
          if (startsNewProviderTurn) this.beginOutstandingTurn(threadId)
          releasePreparation()
          // The chat row id every client already has for this message, which
          // is what a held message is listed, promoted and cancelled by.
          const queuedId = input.delivery === 'queue' ? echoMessageId(input.origin) : undefined
          if (queuedId) {
            this.queuedTurns.expect(queuedId, queuedTurnComposerText(input.providerText, input.displayBody, input.pillsMeta), Date.now())
          }
          try {
            await adapter.sendTurn(threadId, input.providerText, input.runtimeMode, input.images, input.delivery, queuedId)
          } catch (error) {
            if (startsNewProviderTurn) this.finishOutstandingTurn(threadId)
            if (isDefiniteAdapterPreconditionFailure(error, threadId)) {
              throw new TurnNotAcceptedError(errorMessage(error), { cause: error })
            }
            throw error
          } finally {
            if (queuedId) this.queuedTurns.settle(queuedId)
          }
        },
      })
    } finally {
      releasePreparation()
    }
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
      await adapter.stopSession(threadId)
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
      this.sessionDescriptors.delete(threadId)
      this.sessionCredentials.delete(threadId)
      this.outstandingTurns.delete(threadId)
      this.queuedTurns.clear(threadId)
      this.turnDepth.delete(threadId)
      this.pendingRequests.delete(threadId)
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
      },
      publish: (event) => { this.bus.publish(event) },
    }
    this.executionRoot = new ExecutionRootCoordinator(executionRootHost)

    this.host.handle(
      ProviderChannels.RELOCATE_EXECUTION_ROOT,
      async (request: RelocateExecutionRootRequest) => {
        if (!this.executionRoot) throw new Error('Execution-root coordinator is not ready')
        return await this.executionRoot.relocate(request)
      },
    )

    const startSession = async (
      initialOpts: SessionStartOpts,
      publishProviderIdentity = true,
      eventGate?: ProviderEventGate,
      credentialSnapshot?: ProviderCredentialSnapshot,
    ): Promise<ProviderSession> => {
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
          }).runtimeMode,
          cwd: this.sessionCwd.get(opts.threadId) ?? live?.cwd ?? opts.cwd,
          createdAt: live?.createdAt ?? Date.now(),
        } satisfies ProviderSession
      }
      const existingStart = this.startingSessions.get(opts.threadId)
      if (existingStart) {
        log.info(`startSession ${opts.threadId} already starting - waiting`)
        return existingStart
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
      })
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
      const session = await adapter.startSession(enrichedOpts, (event) => {
        if (this.sessionEpochs.get(opts.threadId) !== executionEpoch) return
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
      trackAnalyticsEvent('session_started', { provider: opts.provider })
      resolveStart(session)
      return session
      } catch (err) {
        if (allocatedEpoch !== null && this.sessionEpochs.get(initialOpts.threadId) === allocatedEpoch) {
          this.sessionEpochs.delete(initialOpts.threadId)
        }
        rejectStart(err)
        throw err
      } finally {
        this.startingSessions.delete(opts.threadId)
      }
    }

    this.managedSessionStarter = (opts) => startSession(opts)

    this.host.handle(ProviderChannels.START_SESSION, startSession)

    this.host.handle(ProviderChannels.SWITCH_INSTANCE, async (
      threadId: string,
      input: ProviderInstanceSwitchRequest,
    ) => {
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
      const remoteTargetConfig = agentType !== 'opencode' && process.env.SWITCHBOARD_REMOTE && input.targetRemoteConfigDir
        ? remoteProviderConfigDir(agentType, input.targetRemoteConfigDir)
        : null
      if (!remoteTargetConfig && (!target || !target.enabled || target.agentType !== agentType)) {
        return failure('invalid-instance', 'That profile is unavailable for this provider')
      }
      if (descriptor.provider === 'opencode') {
        return failure('unsupported-provider', 'OpenCode cannot preserve an existing thread across profile changes yet')
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
      const oldRemoteConfig = oldCredentials.remoteConfigDir && agentType !== 'opencode'
        ? remoteProviderConfigDir(agentType, oldCredentials.remoteConfigDir)
        : null
      const codexDefaultDir = remoteProviderConfigDir('codex', undefined)
      const startFresh = input.onContextConflict === 'start-fresh'
        try {
          const stopped = await stopSession(threadId)
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
          const targetSession = await startSession(targetOpts, false, targetEventGate)
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
      try {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) {
        log.warn(`sendTurn ${threadId} - no adapter (session not started?)`)
        throw new Error(`No session: ${threadId}`)
      }
      const acceptedImages = validateUserMessageImages(images)
      log.info(`sendTurn ${threadId} chars=${message.length} mode=${runtimeMode ?? 'sandbox'} images=${acceptedImages?.length ?? 0}`)
      if (adapter.provider === 'opencode' && this.hasOutstandingTurn(threadId)) {
        throw new TurnNotAcceptedError('OpenCode is mid-turn and cannot take another message yet')
      }
      const dispatch = async (): Promise<void> => {
        // These operations happen before the provider boundary. A failure here
        // is a definite rejection and may safely release the reservation.
        try {
          const cwd = this.sessionCwd.get(threadId)
          if (cwd) await this.checkpoints.beginTurn(threadId, cwd)
          notebookManager.beginTurn(threadId)
          this.turnDepth.set(threadId, 0)
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
        try {
          await adapter.sendTurn(threadId, message, runtimeMode, acceptedImages)
        } catch (error) {
          if (startsNewProviderTurn) this.finishOutstandingTurn(threadId)
          // Once the provider call starts, a generic failure is ambiguous. It
          // must remain dispatching so a retry cannot execute the turn twice.
          throw error
        }
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
      } finally {
        releasePreparation()
      }
    })

    // A client asked, so the user typed it. `initiator` is forced rather than
    // read: honouring a claimed `'agent'` would let a client take the agent
    // path's budget while skipping the approval canUseTool gives it.
    this.host.handle(ProviderChannels.DELIVER_PEER_MESSAGE, async (input: PeerMessageInput) =>
      this.deliverPeerMessage({ ...input, initiator: 'user' }))

    this.host.handle(ProviderChannels.INTERRUPT, async (threadId: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      await adapter.interruptTurn(threadId)
    })

    this.host.handle(ProviderChannels.SET_RUNTIME_MODE, async (threadId: string, mode: RuntimeMode) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      await adapter.setRuntimeMode(threadId, mode)
    })

    this.host.handle(ProviderChannels.SET_MODEL, async (threadId: string, model: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      if (adapter.setModel) await adapter.setModel(threadId, model)
    })

    this.host.handle(ProviderChannels.ANSWER_QUESTION, async (threadId: string, requestId: string, answers: string[][]) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      if (adapter.answerQuestion) await adapter.answerQuestion(threadId, requestId, answers)
    })

    this.host.handle(ProviderChannels.RESPOND_TO_REQUEST, async (threadId: string, requestId: string, decision: ApprovalDecision) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
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

    this.host.handle(ProviderChannels.LIST_QUEUED_TURNS, (threadId: string) => this.listQueuedTurns(threadId))
    this.host.handle(ProviderChannels.PROMOTE_QUEUED_TURN, (threadId: string, messageId: string) =>
      this.actOnQueuedTurn('promote', threadId, messageId))
    this.host.handle(ProviderChannels.CANCEL_QUEUED_TURN, (threadId: string, messageId: string) =>
      this.actOnQueuedTurn('cancel', threadId, messageId))

    this.host.handle(ProviderChannels.OPENCODE_LIST_MODELS, async () => {
      try {
        // Alias for desktops older than 0.8.62, which still ask for bare ids.
        return (await this.opencodeAcp.listModels('')).map((m) => m.id)
      } catch {
        return []
      }
    })

    // A user stop is deliberate: a relocation waiting for a turn that will
    // never arrive must not fire against the next session on this thread.
    this.host.handle(ProviderChannels.STOP_SESSION, async (threadId: string) => {
      this.executionRoot?.onSessionStopped(threadId)
      return await stopSession(threadId)
    })

    log.info('IPC handlers registered')
  }

  async stopAll(): Promise<void> {
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
