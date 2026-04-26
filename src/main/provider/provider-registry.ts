/**
 * Provider registry — manages adapter instances and routes operations.
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { ProviderChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import { ClaudeAdapter } from './adapters/claude-adapter'
import { CodexAdapter } from './adapters/codex-adapter'
import { OpencodeAdapter } from './adapters/opencode-adapter'
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
  private window: BrowserWindow
  private sessionAdapters = new Map<string, ProviderKind>()

  constructor(window: BrowserWindow) {
    this.window = window
    this.adapters = new Map<ProviderKind, ProviderAdapter>([
      ['claude', new ClaudeAdapter()],
      ['codex', new CodexAdapter()],
      ['opencode', new OpencodeAdapter()],
    ])
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
      const adapter = this.getAdapter(opts.provider)
      if (!adapter) throw new Error(`Unknown provider: ${opts.provider}`)

      this.sessionAdapters.set(opts.threadId, opts.provider)
      const session = await adapter.startSession(opts, (event) => this.emitEvent(event))
      return session
    })

    ipcMain.handle(ProviderChannels.SEND_TURN, async (_event, threadId: string, message: string, runtimeMode?: RuntimeMode, images?: Array<{ url: string; mimeType?: string }>) => {
      const provider = this.sessionAdapters.get(threadId)
      if (!provider) throw new Error(`No session: ${threadId}`)
      const adapter = this.getAdapter(provider)!
      await adapter.sendTurn(threadId, message, runtimeMode, images)
    })

    ipcMain.handle(ProviderChannels.INTERRUPT, async (_event, threadId: string) => {
      const provider = this.sessionAdapters.get(threadId)
      if (!provider) return
      const adapter = this.getAdapter(provider)!
      await adapter.interruptTurn(threadId)
    })

    ipcMain.handle(ProviderChannels.SET_RUNTIME_MODE, async (_event, threadId: string, mode: RuntimeMode) => {
      const provider = this.sessionAdapters.get(threadId)
      if (!provider) return
      const adapter = this.getAdapter(provider)!
      await adapter.setRuntimeMode(threadId, mode)
    })

    ipcMain.handle(ProviderChannels.SET_MODEL, async (_event, threadId: string, model: string) => {
      const provider = this.sessionAdapters.get(threadId)
      if (!provider) return
      const adapter = this.getAdapter(provider)!
      if (adapter.setModel) await adapter.setModel(threadId, model)
    })

    ipcMain.handle(ProviderChannels.ANSWER_QUESTION, async (_event, threadId: string, requestId: string, answers: string[][]) => {
      const provider = this.sessionAdapters.get(threadId)
      if (!provider) return
      const adapter = this.getAdapter(provider)!
      if (adapter.answerQuestion) await adapter.answerQuestion(threadId, requestId, answers)
    })

    ipcMain.handle(ProviderChannels.RESPOND_TO_REQUEST, async (_event, threadId: string, requestId: string, decision: ApprovalDecision) => {
      const provider = this.sessionAdapters.get(threadId)
      if (!provider) return
      const adapter = this.getAdapter(provider)!
      await adapter.respondToRequest(threadId, requestId, decision)
    })

    ipcMain.handle(ProviderChannels.LIST_SKILLS, async (_event, threadId: string) => {
      const provider = this.sessionAdapters.get(threadId)
      if (!provider) return []
      const adapter = this.getAdapter(provider)
      if (!adapter?.listSkills) return []
      try {
        return await adapter.listSkills(threadId)
      } catch (err) {
        log.warn(`listSkills failed for ${threadId}: ${err}`)
        return []
      }
    })

    ipcMain.handle(ProviderChannels.OPENCODE_LIST_MODELS, async () => {
      const adapter = this.getAdapter('opencode') as any
      if (!adapter?.listAvailableModels) return []
      try {
        return await adapter.listAvailableModels()
      } catch {
        return []
      }
    })

    ipcMain.handle(ProviderChannels.STOP_SESSION, async (_event, threadId: string) => {
      const provider = this.sessionAdapters.get(threadId)
      if (!provider) return
      const adapter = this.getAdapter(provider)!
      await adapter.stopSession(threadId)
      this.sessionAdapters.delete(threadId)
    })

    log.info('IPC handlers registered')
  }

  async stopAll(): Promise<void> {
    for (const [threadId, provider] of this.sessionAdapters) {
      const adapter = this.getAdapter(provider)
      if (adapter) {
        await adapter.stopSession(threadId).catch(() => {})
      }
    }
    this.sessionAdapters.clear()
  }
}
