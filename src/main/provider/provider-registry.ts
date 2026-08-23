/**
 * Provider registry - manages adapter instances and routes operations.
 */

import type { BackendHost } from '../backend/host'
import { ProviderChannels } from '@shared/ipc-channels'
import { applyContentText } from '@shared/content-stream'
import { createMainLogger as createLogger } from '../logger'
import { ClaudeAdapter } from './adapters/claude-adapter'
import { CodexAdapter } from './adapters/codex-adapter'
import { OpencodeAcpAdapter } from './adapters/opencode-acp-adapter'
import { assertCwdReadable } from '../path-access'
import { RuntimeEventBus } from './event-bus'
import { DriftWatcher, parseWorktreeList, type WorktreeRef } from './worktree-drift'
import { realpathOrAncestor } from '../ipc/files'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CheckpointTracker } from './checkpoint-tracker'
import { notebookManager } from '../notebooks/manager'
import { filterNotebookFileEdits } from '../notebooks/file-edit-filter'
import { getProviderInstanceFull, resolveProviderInstance, listOauthDirsForAgent } from '../db/providerInstances'
import { commitConversationProviderSwitch, recordConversationSegment, recordThreadSession, updateConversationSessionId, saveMessageIfAbsent, getConversationTitle, resolveRootThreadId, getDb } from '../db/database'
import { SqliteTurnAcceptanceStore } from '../db/turn-acceptance'
import { currentBackendRequestContext, hashClientScope } from '../backend/request-context'
import {
  AtomicUserTurnSubmission,
  DurableTurnAcceptance,
  TurnNotAcceptedError,
  TurnOriginConflictError,
  type TurnAcceptanceResult,
} from './durable-turn-acceptance'
import { sessionDefaultsFor } from './session-defaults'
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
import type { AgentType } from '@shared/types'
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
} from '@shared/provider-events'

const log = createLogger('provider:registry')

/** `claude` is spelled `claude-code` everywhere the DB is involved. */
function agentTypeForProvider(provider: ProviderKind): Exclude<AgentType, 'terminal'> {
  return provider === 'claude' ? 'claude-code' : provider
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
  private readonly atomicTurnSubmission: Pick<AtomicUserTurnSubmission, 'submit'>
  /** Provider startup shared by every client that reaches a thread before its adapter exists. */
  private startingSessions = new Map<string, Promise<ProviderSession>>()
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
    atomicTurnSubmission?: Pick<AtomicUserTurnSubmission, 'submit'>,
  ) {
    activeRegistry = this
    this.host = host
    this.opencodeAcp = new OpencodeAcpAdapter()
    this.adapters = adapters ?? new Map<ProviderKind, ProviderAdapter>([
      ['claude', new ClaudeAdapter()],
      ['codex', new CodexAdapter()],
      ['opencode', this.opencodeAcp],
    ])
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

  /**
   * In-flight assistant text per thread, mirrored to SQLite on turn end.
   * Without it a reply lives only in the provider's transcript file, which
   * Claude Code prunes and rotates. Persisted here, not in ChatPanel, for the
   * same reason as the error card above: a headless server has no window.
   */
  private pendingAssistantText = new Map<string, Map<string, string>>()

  /** Fold one content delta into the in-flight turn buffer. */
  private bufferAssistantText(event: RuntimeEvent): void {
    if (event.type !== 'content' || event.streamKind !== 'assistant') return
    let byMessage = this.pendingAssistantText.get(event.threadId)
    if (!byMessage) {
      byMessage = new Map()
      this.pendingAssistantText.set(event.threadId, byMessage)
    }
    byMessage.set(
      event.messageId,
      applyContentText(byMessage.get(event.messageId), { text: event.text, append: event.append }),
    )
  }

  /** Mirror the finished turn's assistant messages, then drop the buffer. */
  private flushAssistantText(threadId: string): void {
    const byMessage = this.pendingAssistantText.get(threadId)
    this.pendingAssistantText.delete(threadId)
    if (!byMessage) return
    for (const [messageId, text] of byMessage) {
      if (!text.trim()) continue
      try {
        saveMessageIfAbsent(messageId, threadId, 'assistant', text)
      } catch (err) {
        log.warn(`failed to mirror assistant message ${messageId} for ${threadId}: ${err}`)
      }
    }
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
    const startsNewProviderTurn = adapter.provider !== 'codex' || !this.hasOutstandingTurn(targetThreadId)
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
    this.bufferAssistantText(event)
    if (event.type === 'turn.completed') this.finishOutstandingTurn(event.threadId)
    this.bus.publish(event)

    // A turn just ended - diff the start-of-turn checkpoint against the
    // working tree and stream one file.edited event per changed file. Fire
    // and forget; the cards land right after the turn.completed marker.
    if (event.type === 'turn.completed') {
      this.flushAssistantText(event.threadId)
      void this.emitFileEdits(event.threadId)
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
      log.info('worktree drift detected', { threadId, worktree: event.worktreePath, branch: event.branch })
      this.bus.publish(event)
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

  private async emitFileEdits(threadId: string): Promise<void> {
    try {
      // Notebook hygiene: checkpoint diffs the mirror system already covers
      // (mirror-path events, engine-performed .ipynb writes) are dropped -
      // the synthetic mirror events drained below are their card source.
      // Direct .ipynb edits that bypassed the mirror stay visible.
      const events = filterNotebookFileEdits(await this.checkpoints.finishTurn(threadId), (ev) =>
        notebookManager.explainsFileEdit(ev)
      )
      for (const ev of [...events, ...notebookManager.drainTurnEdits(threadId)]) this.bus.publish(ev)
    } catch (err) {
      log.warn(`emitFileEdits failed for ${threadId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async submitAtomicUserTurn(input: UserTurnSubmissionV1): Promise<UserTurnSubmissionResult> {
    const threadId = input.threadId
    if (this.switchingSessions.has(threadId)) {
      return rejectedAtomicTurn('Session queue full while a profile switch is in progress')
    }
    const starting = this.startingSessions.get(threadId)
    if (starting) await starting
    if (this.switchingSessions.has(threadId)) {
      return rejectedAtomicTurn('Session queue full while a profile switch is in progress')
    }
    const adapter = this.sessionAdapters.get(threadId)
    if (!adapter) return rejectedAtomicTurn(`No session: ${threadId}`)

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
        prepare: async () => {
          if (this.switchingSessions.has(threadId)) {
            throw new TurnNotAcceptedError('Session queue full while a profile switch is in progress')
          }
          if (adapter.provider === 'opencode' && this.hasOutstandingTurn(threadId)) {
            throw new TurnNotAcceptedError('OpenCode is mid-turn and cannot take another message yet')
          }
          try {
            const cwd = this.sessionCwd.get(threadId)
            if (cwd) await this.checkpoints.beginTurn(threadId, cwd)
            notebookManager.beginTurn(threadId)
            this.turnDepth.set(threadId, 0)
          } catch (error) {
            throw new TurnNotAcceptedError('turn preparation failed before provider dispatch', { cause: error })
          }
        },
        dispatch: async () => {
          const startsNewProviderTurn = adapter.provider !== 'codex' || !this.hasOutstandingTurn(threadId)
          if (startsNewProviderTurn) this.beginOutstandingTurn(threadId)
          releasePreparation()
          try {
            await adapter.sendTurn(threadId, input.providerText, input.runtimeMode, input.images)
          } catch (error) {
            if (startsNewProviderTurn) this.finishOutstandingTurn(threadId)
            throw error
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
      return checkRemoteProviderAuth(agentType, remoteProviderConfigDir(agentType, remoteConfigDir))
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
      this.flushAssistantText(threadId)
      this.sessionAdapters.delete(threadId)
      this.sessionCwd.delete(threadId)
      this.sessionStatus.delete(threadId)
      this.sessionDescriptors.delete(threadId)
      this.sessionCredentials.delete(threadId)
      this.outstandingTurns.delete(threadId)
      this.turnDepth.delete(threadId)
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
          runtimeMode: sessionDefaultsFor(opts.threadId, agentTypeForProvider(opts.provider), {
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
      void startPromise.catch(() => {})
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
          const prompt = remoteProviderLoginPrompt(remoteAgentType, remoteProviderConfig)
          if (prompt) throw new Error(prompt)
        }
      }

      // Fill in whatever the client left unsaid from this conversation's own
      // stored state, then the machine default. Without this a chat reopened
      // from the phone silently restarted in sandbox with the default profile,
      // whatever the desktop had set on it.
      const defaults = sessionDefaultsFor(opts.threadId, agentTypeForProvider(opts.provider), {
        runtimeMode: opts.runtimeMode,
        model: opts.model,
        instanceId: opts.instanceId,
      })
      opts = { ...opts, ...defaults }

      log.info(`startSession ${opts.threadId} provider=${opts.provider} cwd=${opts.cwd} mode=${defaults.runtimeMode} instance=${defaults.instanceId ?? '(default)'}`)
      // Catch macOS TCC denials before the adapter spawns - otherwise the
      // SDK fails deep in the stack with cryptic EPERMs.
      await assertCwdReadable(opts.cwd)

      const agentType = agentTypeForProvider(opts.provider)
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
      log.info(`startSession resolved instance=${instance?.id ?? '(none)'} oauthDir=${enrichedOpts.resolvedOauthDir ?? '(none)'} candidates=[${candidateOauthDirs.join(', ')}]`)

      let latestSessionId = opts.resumeSessionId
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
      if (this.switchingSessions.has(threadId) || this.startingSessions.has(threadId) || this.preparingTurns.has(threadId) || this.hasOutstandingTurn(threadId) || this.sessionStatus.get(threadId) === 'running') {
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

      const agentType = agentTypeForProvider(descriptor.provider)
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
          await stopSession(threadId).catch(() => {})
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
        } catch (error) {
          throw new TurnNotAcceptedError('turn preparation failed before provider dispatch', { cause: error })
        }

        const startsNewProviderTurn = adapter.provider !== 'codex' || !this.hasOutstandingTurn(threadId)
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

    this.host.handle(ProviderChannels.OPENCODE_LIST_MODELS, async () => {
      try {
        return await this.opencodeAcp.listAvailableModels()
      } catch {
        return []
      }
    })

    this.host.handle(ProviderChannels.STOP_SESSION, stopSession)

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

function rejectedAtomicTurn(reason: string): UserTurnSubmissionResult {
  return {
    status: 'rejected',
    accepted: false,
    duplicate: false,
    state: 'rejected',
    retryable: true,
    reason,
  }
}

function legacyAcceptanceResult(result: UserTurnSubmissionResult): TurnAcceptanceResult {
  if (result.status === 'accepted') {
    return { accepted: true, duplicate: result.duplicate, state: 'completed' }
  }
  if (result.status === 'pending' || result.status === 'ambiguous') {
    return {
      accepted: false,
      duplicate: result.duplicate,
      state: result.state,
      reason: result.reason,
    }
  }
  if (result.status === 'conflict') throw new TurnOriginConflictError()
  throw new TurnNotAcceptedError(result.reason)
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
