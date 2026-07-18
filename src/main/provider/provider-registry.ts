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
import { CheckpointTracker } from './checkpoint-tracker'
import { notebookManager } from '../notebooks/manager'
import { filterNotebookFileEdits } from '../notebooks/file-edit-filter'
import { resolveProviderInstance, listOauthDirsForAgent } from '../db/providerInstances'
import { recordThreadSession, updateConversationSessionId } from '../db/database'
import { defaultClaudeDir } from './claude-session-migrate'
import { remoteBlockedProviderLabel, remoteClaudeLoginPrompt, remoteClaudeConfigDir, checkRemoteClaudeAuth } from './remote-gate'
import type { AgentType } from '@shared/types'
import type {
  ProviderAdapter,
  ProviderKind,
  RuntimeEvent,
  SessionStartOpts,
  ApprovalDecision,
  RuntimeMode,
} from './types'

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

  private publish(event: RuntimeEvent): void {
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
      // Gather every known oauth_dir for this agent kind so the adapter
      // can scan them on cold-start (lastOauthDir map empty after app
      // restart) to find a resumeable JSONL across profiles. Always
      // includes the default dir so env-mode sessions (no oauth_dir) are
      // discoverable too.
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
      this.sessionAdapters.set(opts.threadId, adapter)
      this.sessionCwd.set(opts.threadId, session.cwd)
      await this.attachNotebooks(opts.threadId, session.cwd)
      return session
    })

    this.host.handle(ProviderChannels.SEND_TURN, async (threadId: string, message: string, runtimeMode?: RuntimeMode, images?: Array<{ url: string; mimeType?: string }>) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) {
        log.warn(`sendTurn ${threadId} - no adapter (session not started?)`)
        throw new Error(`No session: ${threadId}`)
      }
      log.info(`sendTurn ${threadId} chars=${message.length} mode=${runtimeMode ?? 'sandbox'} images=${images?.length ?? 0}`)
      // Snapshot the working tree BEFORE the agent edits, so the post-turn
      // diff isolates exactly this turn's changes. No-op for non-git dirs.
      const cwd = this.sessionCwd.get(threadId)
      if (cwd) await this.checkpoints.beginTurn(threadId, cwd)
      notebookManager.beginTurn(threadId)
      await adapter.sendTurn(threadId, message, runtimeMode, images)
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
