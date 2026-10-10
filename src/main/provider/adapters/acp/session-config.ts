/**
 * Pure helpers for the parts of an ACP session that agents report in more
 * than one shape: the mode ids and the model catalog.
 */
import type { ModelInfo, SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk'
import type { RuntimeMode } from '../../types'
import type { AcpModeStrategy } from './launch-config'

/** The ACP mode ids a session maps Switchboard's runtime modes onto. */
export interface AcpModeIds {
  /** Mode id for plan, or null when the agent has no plan mode. */
  plan: string | null
  /** Mode id for every other runtime mode, or null to leave the mode alone. */
  other: string | null
}

export function resolveAcpModeIds(strategy: AcpModeStrategy, modes: SessionModeState | null | undefined): AcpModeIds {
  if (strategy.kind === 'fixed') return { plan: strategy.plan, other: strategy.other }
  if (!modes) return { plan: null, other: null }
  const plan = modes.availableModes.find((m) => m.id.toLowerCase() === 'plan')?.id ?? null
  // The mode the session starts in is the agent's own default. When it
  // started in plan (a restored session), there is no safe "other" to go to.
  const other = plan !== null && modes.currentModeId === plan ? null : modes.currentModeId
  return { plan, other }
}

export function acpModeFor(ids: AcpModeIds, mode: RuntimeMode): string | null {
  return mode === 'plan' ? ids.plan : ids.other
}

/** A model picker carried as a session config option (`category: model`). */
export interface AcpConfigModels {
  configId: string
  current: string
  models: ModelInfo[]
}

/**
 * The model catalog from `configOptions`, for agents that report models
 * there instead of in `models`. Grouped options are flattened.
 */
export function modelsFromConfigOptions(options: readonly SessionConfigOption[] | null | undefined): AcpConfigModels | null {
  const option = options?.find((o) => o.category === 'model' && o.type === 'select')
  if (!option || option.type !== 'select') return null
  const models: ModelInfo[] = []
  for (const entry of option.options) {
    if ('group' in entry) {
      for (const inner of entry.options) models.push({ modelId: inner.value, name: inner.name })
    } else {
      models.push({ modelId: entry.value, name: entry.name })
    }
  }
  return { configId: option.id, current: option.currentValue, models }
}
