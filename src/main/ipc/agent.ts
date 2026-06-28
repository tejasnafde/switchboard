import type { BackendHost } from '../backend/host'
import { AgentChannels } from '@shared/ipc-channels'
import type { AgentStartOptions, AgentSendPayload } from '@shared/types'
import { AgentManager } from '../agent/agent-manager'

let agentManager: AgentManager | null = null

export function registerAgentHandlers(host: BackendHost): void {
  agentManager?.killAll()

  agentManager = new AgentManager(
    (agentId, message) => host.emit(AgentChannels.MESSAGE, agentId, message),
    (agentId, messageId, updates) => host.emit(AgentChannels.MESSAGE_UPDATE, agentId, messageId, updates),
    (agentId, status) => host.emit(AgentChannels.STATUS, agentId, status),
    (agentId, error) => host.emit(AgentChannels.ERROR, agentId, error),
  )

  host.handle(AgentChannels.START, async (opts: AgentStartOptions) => {
    await agentManager!.start(opts)
    return { id: opts.id }
  })

  host.handle(AgentChannels.SEND, async (payload: AgentSendPayload) => {
    await agentManager!.send(payload.id, payload.message)
    return { ok: true }
  })

  host.on(AgentChannels.KILL, (id: string) => {
    agentManager!.kill(id)
  })
}
