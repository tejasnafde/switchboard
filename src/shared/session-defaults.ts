/**
 * What a session starts as when the client did not say: request, then this
 * conversation's stored value, then the machine default. `START_SESSION` used
 * to fall straight to a hardcoded `'sandbox'`, so a phone-opened chat ignored
 * however the desktop had it set.
 *
 * Per FIELD, not per tier - the phone sends a mode and no model.
 */
import type { RuntimeMode } from './provider-events'

/** Shared: the desktop writes these, the backend reads them, the phone reads
 *  them over `settings:get`. Three places that must agree on a string. */
export const SETTING_DEFAULT_RUNTIME_MODE = 'chat.defaultRuntimeMode'
export const SETTING_DEFAULT_INSTANCE_ID = 'chat.defaultProviderInstanceId'

/** Per agent: a model id almost never means anything to another provider. */
export function defaultModelSettingKey(agentType: string): string {
  return `chat.defaultModel.${agentType}`
}

const RUNTIME_MODES: readonly RuntimeMode[] = ['plan', 'sandbox', 'accept-edits', 'full-access']

/** An unknown mode must never widen permissions. */
export const FALLBACK_RUNTIME_MODE: RuntimeMode = 'sandbox'

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return typeof value === 'string' && (RUNTIME_MODES as readonly string[]).includes(value)
}

/** One tier's opinion. Every field optional. */
export interface SessionDefaults {
  runtimeMode?: string
  model?: string
  instanceId?: string
}

export interface ResolvedSessionDefaults {
  runtimeMode: RuntimeMode
  model?: string
  instanceId?: string
}

/** Empty string means cleared, which is absent. */
function firstSet(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

export function resolveSessionDefaults(tiers: {
  requested: SessionDefaults
  conversation: SessionDefaults
  machine: SessionDefaults
}): ResolvedSessionDefaults {
  const { requested, conversation, machine } = tiers
  // Per tier, so a bad mode from a client falls through instead of poisoning.
  const runtimeMode =
    [requested.runtimeMode, conversation.runtimeMode, machine.runtimeMode].find(isRuntimeMode) ??
    FALLBACK_RUNTIME_MODE

  return {
    runtimeMode,
    model: firstSet(requested.model, conversation.model, machine.model),
    instanceId: firstSet(requested.instanceId, conversation.instanceId, machine.instanceId),
  }
}
