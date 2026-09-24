import type { AgentType } from '@shared/types'
import type { ReasoningEffort } from '@shared/models'
import { defaultModelSettingKey, SETTING_DEFAULT_RUNTIME_MODE } from '@shared/session-defaults'
import { useAgentStore, setStoreDefaultRuntimeMode, type RuntimeMode } from '../../stores/agent-store'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:panel')

export function changeRuntimeMode(sessionId: string, mode: RuntimeMode): void {
  useAgentStore.getState().setRuntimeMode(sessionId, mode)
  // Propagate to active provider session if running
  ;window.api.provider?.setRuntimeMode?.(sessionId, mode).catch((err: unknown) => {
    log.warn(`setRuntimeMode failed for ${sessionId} - live provider session may not have applied it`, err)
  })
  // Persist as the per-conversation source of truth so reopening this
  // chat (sidebar, kanban card click, ⌘⇧F search jump) restores the
  // selection instead of falling back to the hardcoded default.
  window.api.app?.setConversationRuntimeMode?.(sessionId, mode).catch((err: unknown) => {
    log.warn(`setConversationRuntimeMode failed for ${sessionId}`, err)
  })
  // Also remember as the user-level default so brand-new sessions seed
  // with this mode instead of always reverting to 'sandbox'.
  setStoreDefaultRuntimeMode(mode)
  window.api.settings
    ?.set?.(SETTING_DEFAULT_RUNTIME_MODE, mode)
    .catch((err: unknown) => log.warn('could not save the default runtime mode', err))
}

export function changeModel(sessionId: string, agentType: AgentType, m: string): void {
  useAgentStore.getState().setModel(sessionId, m)
  // Propagate to the running provider session (opencode reads this per
  // turn; Claude/Codex no-op). Without this, the adapter keeps using
  // whatever model was passed at startSession forever.
  window.api.provider.setModel?.(sessionId, m).catch((err: unknown) => {
    log.warn(`setModel failed for ${sessionId} - live provider session may not have applied it`, err)
  })
  // Persist as the per-conversation source of truth so reopening this
  // chat (sidebar, kanban card click) restores the pin instead of losing
  // it the moment the live session object stops matching session.id.
  window.api.app?.setConversationModel?.(sessionId, m).catch((err: unknown) => {
    log.warn(`setConversationModel failed for ${sessionId}`, err)
  })
  // And as the machine default, so a session started from anywhere else -
  // notably the phone, which cannot see this window - opens on the same
  // model instead of whatever the provider CLI picks.
  window.api.settings
    ?.set?.(defaultModelSettingKey(agentType), m)
    .catch((err: unknown) => log.warn('could not save the default model', err))
}

export function changeReasoningEffort(sessionId: string, effort: ReasoningEffort): void {
  useAgentStore.getState().setReasoningEffort(sessionId, effort)
  window.api.app.setConversationReasoningEffort(sessionId, effort).catch((err: unknown) => {
    log.warn(`setConversationReasoningEffort failed for ${sessionId}`, err)
  })
}
