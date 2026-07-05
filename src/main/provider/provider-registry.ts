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
import { CheckpointTracker } from './checkpoint-tracker'
import { resolveProviderInstance, listOauthDirsForAgent } from '../db/providerInstances'
import { recordThreadSession, updateConversationSessionId } from '../db/database'
import { defaultClaudeDir } from './claude-session-migrate'
import { remoteBlockedProviderLabel, remoteClaudeLoginPrompt, remoteClaudeConfigDir } from './remote-gate'
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
    this.host = host
    this.opencodeAcp = new OpencodeAcpAdapter()
    this.adapters = adapters ?? new Map<ProviderKind, ProviderAdapter>([
      ['claude', new ClaudeAdapter()],
      ['codex', new CodexAdapter()],
      ['opencode', this.opencodeAcp],
    ])
    this.bus = new RuntimeEventBus()
    this.rendererUnsub = this.bus.subscribe((event) => this.forwardToRenderer(event))
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
  }

  private async emitFileEdits(threadId: string): Promise<void> {
    try {
      const events = await this.checkpoints.finishTurn(threadId)
      for (const ev of events) this.bus.publish(ev)
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
