import { ipcMain, type BrowserWindow } from 'electron'
import { AgentChannels } from '@shared/ipc-channels'
import type { AgentStartOptions, AgentSendPayload } from '@shared/types'
import { AgentManager } from '../agent/agent-manager'

let agentManager: AgentManager | null = null

export function registerAgentHandlers(window: BrowserWindow): void {
  agentManager?.killAll()
  ipcMain.removeHandler(AgentChannels.START)
  ipcMain.removeHandler(AgentChannels.SEND)
  ipcMain.removeAllListeners(AgentChannels.KILL)

  agentManager = new AgentManager(
    // onMessage — new message
    (agentId, message) => {
      if (!window.isDestroyed()) {
        window.webContents.send(AgentChannels.MESSAGE, agentId, message)
      }
    },
    // onMessageUpdate — update existing streaming message
    (agentId, messageId, updates) => {
      if (!window.isDestroyed()) {
        window.webContents.send(AgentChannels.MESSAGE_UPDATE, agentId, messageId, updates)
      }
    },
    // onStatus
    (agentId, status) => {
      if (!window.isDestroyed()) {
        window.webContents.send(AgentChannels.STATUS, agentId, status)
      }
    },
    // onError
    (agentId, error) => {
      if (!window.isDestroyed()) {
        window.webContents.send(AgentChannels.ERROR, agentId, error)
      }
    }
  )

  ipcMain.handle(AgentChannels.START, async (_event, opts: AgentStartOptions) => {
    await agentManager!.start(opts)
    return { id: opts.id }
  })

  ipcMain.handle(AgentChannels.SEND, async (_event, payload: AgentSendPayload) => {
    await agentManager!.send(payload.id, payload.message)
    return { ok: true }
  })

  ipcMain.on(AgentChannels.KILL, (_event, id: string) => {
    agentManager!.kill(id)
  })
}
