/**
 * Provider registry — manages adapter instances and routes operations.
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { ProviderChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import { ClaudeAdapter } from './adapters/claude-adapter'
import { CodexAdapter } from './adapters/codex-adapter'
import { OpencodeAcpAdapter } from './adapters/opencode-acp-adapter'
import { assertCwdReadable } from '../path-access'
import { RuntimeEventBus } from './event-bus'
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
  private window: BrowserWindow
  /**
   * Per-session resolved adapter. Stored separately from the provider-kind
   * map so existing sessions stay pinned to the adapter instance they
   * started on, even if we ever swap adapters at runtime in the future.
   */
  private sessionAdapters = new Map<string, ProviderAdapter>()
  private sessionProviders = new Map<string, ProviderKind>()

  /**
   * Event bus that decouples adapter event emission from the consumer.
   * Today there's one consumer (the renderer bridge); the kanban board
   * adds a second (a task-state recorder) without touching adapters.
   */
  readonly bus: RuntimeEventBus
  /** Unsubscribe fn for the renderer bridge subscription. */
  private rendererUnsub: (() => void) | null = null

  constructor(window: BrowserWindow) {
    this.window = window
    this.opencodeAcp = new OpencodeAcpAdapter()
    this.adapters = new Map<ProviderKind, ProviderAdapter>([
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
   * Renderer bridge subscriber. Forwards every event to the current
   * window's webContents iff the window still exists. If the window has
   * been destroyed we silently drop — other subscribers (kanban
   * recorder, etc.) still receive it because they're independent.
   */
  private forwardToRenderer(event: RuntimeEvent): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(ProviderChannels.EVENT, event)
    }
  }

  private publish(event: RuntimeEvent): void {
    this.bus.publish(event)
  }

  registerIpcHandlers(): void {
    // Clean up previous handlers
    for (const ch of Object.values(ProviderChannels)) {
      try { ipcMain.removeHandler(ch) } catch { /* ignore */ }
    }

    ipcMain.handle(ProviderChannels.IS_AVAILABLE, async (_event, provider: ProviderKind) => {
      const adapter = this.getAdapter(provider)
      if (!adapter) return false
      return adapter.isAvailable()
    })

    ipcMain.handle(ProviderChannels.START_SESSION, async (_event, opts: SessionStartOpts) => {
      const adapter = this.getAdapter(opts.provider)
      if (!adapter) throw new Error(`Unknown provider: ${opts.provider}`)

      // Catch macOS TCC denials before the adapter spawns — otherwise the
      // SDK fails deep in the stack with cryptic EPERMs.
      await assertCwdReadable(opts.cwd)

      this.sessionAdapters.set(opts.threadId, adapter)
      this.sessionProviders.set(opts.threadId, opts.provider)
      const session = await adapter.startSession(opts, (event) => this.publish(event))
      return session
    })

    ipcMain.handle(ProviderChannels.SEND_TURN, async (_event, threadId: string, message: string, runtimeMode?: RuntimeMode, images?: Array<{ url: string; mimeType?: string }>) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) throw new Error(`No session: ${threadId}`)
      await adapter.sendTurn(threadId, message, runtimeMode, images)
    })

    ipcMain.handle(ProviderChannels.INTERRUPT, async (_event, threadId: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      await adapter.interruptTurn(threadId)
    })

    ipcMain.handle(ProviderChannels.SET_RUNTIME_MODE, async (_event, threadId: string, mode: RuntimeMode) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      await adapter.setRuntimeMode(threadId, mode)
    })

    ipcMain.handle(ProviderChannels.SET_MODEL, async (_event, threadId: string, model: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      if (adapter.setModel) await adapter.setModel(threadId, model)
    })

    ipcMain.handle(ProviderChannels.ANSWER_QUESTION, async (_event, threadId: string, requestId: string, answers: string[][]) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      if (adapter.answerQuestion) await adapter.answerQuestion(threadId, requestId, answers)
    })

    ipcMain.handle(ProviderChannels.RESPOND_TO_REQUEST, async (_event, threadId: string, requestId: string, decision: ApprovalDecision) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      await adapter.respondToRequest(threadId, requestId, decision)
    })

    ipcMain.handle(ProviderChannels.LIST_SKILLS, async (_event, threadId: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter?.listSkills) return []
      try {
        return await adapter.listSkills(threadId)
      } catch (err) {
        log.warn(`listSkills failed for ${threadId}: ${err}`)
        return []
      }
    })

    ipcMain.handle(ProviderChannels.OPENCODE_LIST_MODELS, async () => {
      try {
        return await this.opencodeAcp.listAvailableModels()
      } catch {
        return []
      }
    })

    ipcMain.handle(ProviderChannels.STOP_SESSION, async (_event, threadId: string) => {
      const adapter = this.sessionAdapters.get(threadId)
      if (!adapter) return
      await adapter.stopSession(threadId)
      this.sessionAdapters.delete(threadId)
      this.sessionProviders.delete(threadId)
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
    this.sessionProviders.clear()
    if (this.rendererUnsub) {
      this.rendererUnsub()
      this.rendererUnsub = null
    }
    this.bus.clear()
  }
}
