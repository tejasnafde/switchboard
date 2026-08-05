/**
 * Provider registry - manages adapter instances and routes operations.
 */

import type { BackendHost } from '../backend/host'
import { ProviderChannels } from '@shared/ipc-channels'
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
import { TurnDeduper } from '@shared/turn-dedupe'
import { CheckpointTracker } from './checkpoint-tracker'
import { notebookManager } from '../notebooks/manager'
import { filterNotebookFileEdits } from '../notebooks/file-edit-filter'
import { resolveProviderInstance, listOauthDirsForAgent } from '../db/providerInstances'
import { recordThreadSession, updateConversationSessionId, saveMessageIfAbsent } from '../db/database'
import { defaultClaudeDir } from './claude-session-migrate'
import { remoteBlockedProviderLabel, remoteClaudeLoginPrompt, remoteClaudeConfigDir, checkRemoteClaudeAuth } from './remote-gate'
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
import { echoMessageId } from '@shared/provider-events'

const log = createLogger('provider:registry')

export class ProviderRegistry {
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
  /** Turn origins already accepted, so a client retry cannot run twice. */
  private turnDedupe = new TurnDeduper()
  /** Threads with a startSession in flight. Claimed before the first await. */
  private startingSessions = new Set<string>()

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
  constructor(host: BackendHost, adapters?: Map<ProviderKind, ProviderAdapter>) {
    activeRegistry = this
    this.host = host
    this.opencodeAcp = new OpencodeAcpAdapter()
    this.adapters = adapters ?? new Map<ProviderKind, ProviderAdapter>([
      ['claude', new ClaudeAdapter()],
      ['codex', new CodexAdapter()],
      ['opencode', this.opencodeAcp],
    ])
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
    this.bus.publish(event)

    // A turn just ended - diff the start-of-turn checkpoint against the
    // working tree and stream one file.edited event per changed file. Fire
    // and forget; the cards land right after the turn.completed marker.
    if (event.type === 'turn.completed') {
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

  registerIpcHandlers(): void {
    this.host.handle(ProviderChannels.IS_AVAILABLE, async (provider: ProviderKind) => {
      // On a remote VM, gray out the providers that don't run there.
      if (process.env.SWITCHBOARD_REMOTE && remoteBlockedProviderLabel(provider)) return false
      const adapter = this.getAdapter(provider)
      if (!adapter) return false
      return adapter.isAvailable()
    })

    // Proactive remote-auth preflight for the chat-open banner. `_threadId`
    // exists ONLY so the preload RoutingTable (which keys on args[0]) routes
    // the call to the machine the session is bound to - the check itself
    // never uses it. Locally there is nothing to preflight, so a non-remote
    // backend always reports logged in; the START_SESSION backstop below
    // still catches any race.
    this.host.handle(ProviderChannels.CHECK_REMOTE_AUTH, async (_threadId: string, remoteConfigDir?: string) => {
      if (!process.env.SWITCHBOARD_REMOTE) return { loggedIn: true }
      return checkRemoteClaudeAuth(remoteClaudeConfigDir(remoteConfigDir))
    })

    this.host.handle(ProviderChannels.START_SESSION, async (opts: SessionStartOpts) => {
      const adapter = this.getAdapter(opts.provider)
      if (!adapter) throw new Error(`Unknown provider: ${opts.provider}`)

      // Idempotent re-attach: a second START_SESSION for a live thread (screen
      // remount, second client on the same backend) must not spawn a second
      // adapter process over the same JSONL. Returns a descriptor instead.
      // Also against a set claimed SYNCHRONOUSLY below: the adapter map is
      // written after `await adapter.startSession`, so two clients racing that
      // window both passed this guard and both spawned a process.
      if (this.sessionAdapters.has(opts.threadId) || this.startingSessions.has(opts.threadId)) {
        log.info(`startSession ${opts.threadId} already live - re-attaching`)
        return {
          threadId: opts.threadId,
          provider: opts.provider,
          status: 'idle',
          runtimeMode: opts.runtimeMode ?? 'sandbox',
          cwd: this.sessionCwd.get(opts.threadId) ?? opts.cwd,
          createdAt: Date.now(),
        } satisfies ProviderSession
      }
      this.startingSessions.add(opts.threadId)
      try {

      // On a remote VM only Claude Code runs. Reject Codex / OpenCode with a
      // readable message the chat surfaces instead of a deep adapter failure.
      let remoteClaudeConfig: string | null = null
      if (process.env.SWITCHBOARD_REMOTE) {
        const blocked = remoteBlockedProviderLabel(opts.provider)
        if (blocked) {
          throw new Error(`${blocked} is not available on remote machines yet - only Claude Code runs on remote VMs.`)
        }
        // Per-device login: resolve this VM's per-instance config dir and, if
        // it has no creds, fail with the login command instead of a raw 401.
        if (opts.provider === 'claude') {
          remoteClaudeConfig = remoteClaudeConfigDir(opts.remoteConfigDir)
          const prompt = remoteClaudeLoginPrompt(remoteClaudeConfig)
          if (prompt) throw new Error(prompt)
        }
      }

      log.info(`startSession ${opts.threadId} provider=${opts.provider} cwd=${opts.cwd} mode=${opts.runtimeMode ?? 'sandbox'} instance=${opts.instanceId ?? '(default)'}`)
      // Catch macOS TCC denials before the adapter spawns - otherwise the
      // SDK fails deep in the stack with cryptic EPERMs.
      await assertCwdReadable(opts.cwd)

      const agentType: AgentType = opts.provider === 'claude' ? 'claude-code' : opts.provider
      const instance = resolveProviderInstance(agentType, opts.instanceId)
      // Every known oauth_dir for this agent kind, so the adapter can find a
      // resumeable JSONL across profiles. Includes the default dir so env-mode
      // sessions (no oauth_dir) are discoverable too.
      const candidateOauthDirs = Array.from(new Set([
        ...listOauthDirsForAgent(agentType),
        defaultClaudeDir(),
      ]))
      const enrichedOpts: SessionStartOpts = {
        ...opts,
        instanceId: instance?.id ?? opts.instanceId,
        resolvedEnv: instance?.env ?? {},
        resolvedOauthDir: instance?.oauthDir ?? null,
        candidateOauthDirs,
      }
      // Remote: point CLAUDE_CONFIG_DIR at the per-instance dir under this VM's $HOME.
      if (remoteClaudeConfig) enrichedOpts.resolvedOauthDir = remoteClaudeConfig
      log.info(`startSession resolved instance=${instance?.id ?? '(none)'} oauthDir=${enrichedOpts.resolvedOauthDir ?? '(none)'} candidates=[${candidateOauthDirs.join(', ')}]`)

      const session = await adapter.startSession(enrichedOpts, (event) => this.publish(event))
      if (instance) session.instanceId = instance.id
      // Tell every client which profile this thread now runs on. A rotation
      // done on one client would otherwise leave the others showing the old
      // one, since only this resolution knows what was actually picked.
      this.publish({
        type: 'session.provider',
        threadId: opts.threadId,
        provider: opts.provider,
        instanceId: instance?.id ?? null,
        instanceName: instance?.displayName ?? null,
      })
      this.sessionAdapters.set(opts.threadId, adapter)
      this.sessionCwd.set(opts.threadId, session.cwd)
      await this.attachNotebooks(opts.threadId, session.cwd)
      return session
      } finally {
        this.startingSessions.delete(opts.threadId)
      }
    })

    this.host.handle(ProviderChannels.SEND_TURN, async (threadId: string, message: string, runtimeMode?: RuntimeMode, images?: Array<{ url: string; mimeType?: string }>, origin?: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) {
        log.warn(`sendTurn ${threadId} - no adapter (session not started?)`)
        throw new Error(`No session: ${threadId}`)
      }
      // A client that retried after an ambiguous failure (socket died with the
      // request on the wire, invoke timed out) cannot know whether this ran.
      // Retrying is the right client behaviour, so the duplicate has to be
      // caught here or the user gets the same turn twice.
      if (this.turnDedupe.isDuplicate(origin)) {
        log.info(`sendTurn ${threadId} - duplicate origin ${origin}, already accepted`)
        return
      }
      log.info(`sendTurn ${threadId} chars=${message.length} mode=${runtimeMode ?? 'sandbox'} images=${images?.length ?? 0}`)
      // Snapshot the working tree BEFORE the agent edits, so the post-turn
      // diff isolates exactly this turn's changes. No-op for non-git dirs.
      const cwd = this.sessionCwd.get(threadId)
      if (cwd) await this.checkpoints.beginTurn(threadId, cwd)
      notebookManager.beginTurn(threadId)
      // Broadcast the user's turn: adapters only emit the agent's side, so
      // without this a message typed on one client is invisible everywhere
      // else. The sender skips its own echo via `origin`.
      try {
        await adapter.sendTurn(threadId, message, runtimeMode, images)
      } catch (err) {
        // Release the origin: the turn did NOT happen, so the client's retry
        // must be allowed through. Holding it would answer the retry with a
        // cheerful success and drop the message silently.
        this.turnDedupe.release(origin)
        throw err
      }
      // Persisted here because the renderer was the only writer, so a turn sent
      // from the phone left no row: absent from search, absent from the DB
      // fallback, and `updated_at` never moved.
      //
      // Fill-only, and that is the whole subtlety. The renderer writes the same
      // id (`echoMessageId`) BEFORE it calls sendTurn, carrying the pill
      // metadata only it has; this runs after, so a plain REPLACE nulled
      // `display_body`/`pills_meta` on every desktop send. Absent origin - the
      // phone's opening turn does not send one - still gets a row, under a
      // minted id, since nothing else will write it.
      try {
        saveMessageIfAbsent(
          origin ? echoMessageId(origin) : `turn_${Date.now()}_${++this.savedMessageSeq}`,
          threadId,
          'user',
          message,
          images && images.length > 0 ? JSON.stringify(images) : undefined,
        )
      } catch (err) {
        log.warn(`failed to persist user turn for ${threadId}: ${err}`)
      }
      // AFTER the adapter accepts. Broadcasting first meant a failed send had
      // already consumed the origin from every other client's skip set, so the
      // retry rendered a duplicate bubble everywhere with no retraction.
      this.publish({ type: 'user.message', threadId, text: message, origin, at: Date.now() })
    })

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

    this.host.handle(ProviderChannels.OPENCODE_LIST_MODELS, async () => {
      try {
        return await this.opencodeAcp.listAvailableModels()
      } catch {
        return []
      }
    })

    this.host.handle(ProviderChannels.STOP_SESSION, async (threadId: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      await adapter.stopSession(threadId)
      this.sessionAdapters.delete(threadId)
      this.sessionCwd.delete(threadId)
      this.checkpoints.clear(threadId)
      this.driftWatcher.onSessionStopped(threadId)
      notebookManager.detach(threadId)
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
