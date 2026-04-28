/**
 * Provider registry — manages adapter instances and routes operations.
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { ProviderChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import { ClaudeAdapter } from './adapters/claude-adapter'
import { CodexAdapter } from './adapters/codex-adapter'
import { OpencodeAdapter } from './adapters/opencode-adapter'
import { OpencodeAcpAdapter } from './adapters/opencode-acp-adapter'
import { assertCwdReadable } from '../path-access'
import { getSetting } from '../db/database'
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
  /** Legacy shell-out OpenCode adapter, kept for one release behind a flag. */
  private opencodeLegacy: OpencodeAdapter
  /** New ACP-based OpenCode adapter (default). */
  private opencodeAcp: OpencodeAcpAdapter
  private window: BrowserWindow
  /**
   * Per-session resolved adapter. Stores the actual instance (not just the
   * provider kind) so the OpenCode flag can change between sessions without
   * disturbing in-flight ones — each session keeps using the adapter it
   * started on.
   */
  private sessionAdapters = new Map<string, ProviderAdapter>()
  private sessionProviders = new Map<string, ProviderKind>()

  constructor(window: BrowserWindow) {
    this.window = window
    this.opencodeLegacy = new OpencodeAdapter()
    this.opencodeAcp = new OpencodeAcpAdapter()
    this.adapters = new Map<ProviderKind, ProviderAdapter>([
      ['claude', new ClaudeAdapter()],
      ['codex', new CodexAdapter()],
      // Default opencode entry mirrors the current setting; resolved fresh on
      // each START_SESSION via resolveOpencodeAdapter().
      ['opencode', this.resolveOpencodeAdapter()],
    ])
  }

  /**
   * Pick the OpenCode adapter to use for a new session. Reads the
   * `opencode.useAcpAdapter` setting (default `true`) so users can fall back
   * to the legacy shell-out adapter while the ACP rewrite stabilizes.
   */
  private resolveOpencodeAdapter(): ProviderAdapter {
    let useAcp = true
    try {
      const v = getSetting('opencode.useAcpAdapter')
      if (v === 'false' || v === '0') useAcp = false
    } catch { /* settings table may not exist in tests */ }
    return useAcp ? this.opencodeAcp : this.opencodeLegacy
  }

  getAdapter(provider: ProviderKind): ProviderAdapter | undefined {
    return this.adapters.get(provider)
  }

  private emitEvent(event: RuntimeEvent): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(ProviderChannels.EVENT, event)
    }
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
      // For OpenCode, re-resolve the adapter on every session start so a
      // toggle of `opencode.useAcpAdapter` takes effect for the next session
      // without an app restart. Existing sessions stay on whichever adapter
      // they were created with (sessionAdapters map).
      let adapter: ProviderAdapter | undefined
      if (opts.provider === 'opencode') {
        adapter = this.resolveOpencodeAdapter()
        this.adapters.set('opencode', adapter)
      } else {
        adapter = this.getAdapter(opts.provider)
      }
      if (!adapter) throw new Error(`Unknown provider: ${opts.provider}`)

      // Catch macOS TCC denials before the adapter spawns — otherwise the
      // SDK fails deep in the stack with cryptic EPERMs.
      await assertCwdReadable(opts.cwd)

      this.sessionAdapters.set(opts.threadId, adapter)
      this.sessionProviders.set(opts.threadId, opts.provider)
      const session = await adapter.startSession(opts, (event) => this.emitEvent(event))
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
      // Use whichever opencode adapter the flag currently points to, so the
      // model list reflects the same source as the next session start.
      const adapter = this.resolveOpencodeAdapter() as any
      if (!adapter?.listAvailableModels) return []
      try {
        return await adapter.listAvailableModels()
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
      await adapter.stopSession(threadId).catch(() => {})
    }
    this.sessionAdapters.clear()
    this.sessionProviders.clear()
  }
}
