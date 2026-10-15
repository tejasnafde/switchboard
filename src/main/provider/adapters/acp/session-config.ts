/**
 * Pure helpers for the parts of an ACP session that agents report in more
 * than one shape: the mode ids and the model catalog.
 */
import type { SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk'
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

/**
 * A model as the agent names it. The ACP SDK dropped its own `ModelInfo` with
 * the unstable model selectors (0.24); older agents still send that shape.
 */
export interface AcpModelInfo {
  modelId: string
  name: string
  description?: string | null
}

/**
 * The unstable `models` field of a `session/new` or `session/resume` reply,
 * which the SDK no longer types but passes through. Null when absent or
 * malformed.
 */
export function legacyModelCatalog(response: unknown): AcpModelInfo[] | null {
  const models = (response as { models?: { availableModels?: unknown } } | null | undefined)?.models
  const list = models?.availableModels
  if (!Array.isArray(list)) return null
  return list.filter((m): m is AcpModelInfo => typeof m?.modelId === 'string' && typeof m?.name === 'string')
}

export function acpModeFor(ids: AcpModeIds, mode: RuntimeMode): string | null {
  return mode === 'plan' ? ids.plan : ids.other
}

/** A model picker carried as a session config option (`category: model`). */
export interface AcpConfigModels {
  configId: string
  current: string
  models: AcpModelInfo[]
}

/**
 * The model catalog from `configOptions`, for agents that report models
 * there instead of in `models`. Grouped options are flattened.
 */
export function modelsFromConfigOptions(
  options: readonly SessionConfigOption[] | null | undefined,
): AcpConfigModels | null {
  const option = options?.find((o) => o.category === 'model' && o.type === 'select')
  if (!option || option.type !== 'select') return null
  const models: AcpModelInfo[] = []
  for (const entry of option.options) {
    if ('group' in entry) {
      for (const inner of entry.options) models.push({ modelId: inner.value, name: inner.name })
    } else {
      models.push({ modelId: entry.value, name: entry.name })
    }
  }
  return { configId: option.id, current: option.currentValue, models }
}

/** The base level of an effort config option (OpenCode 2.x: the model with no variant). */
export const CONFIG_EFFORT_DEFAULT = 'default'

/** A thinking-effort picker carried as a session config option. */
export interface AcpConfigEffort {
  configId: string
  current: string
  values: string[]
}

/**
 * The effort option among `configOptions`: the one named `configId` when
 * given, else the first `category: thought_level` select. Null when the
 * current model has none (OpenCode 2.x drops it for a model without variants).
 */
export function effortFromConfigOptions(
  options: readonly SessionConfigOption[] | null | undefined,
  configId?: string | null,
): AcpConfigEffort | null {
  const option = options?.find((o) => (configId ? o.id === configId : o.category === 'thought_level'))
  if (!option || option.type !== 'select') return null
  const values: string[] = []
  for (const entry of option.options) {
    if ('group' in entry) values.push(...entry.options.map((inner) => inner.value))
    else values.push(entry.value)
  }
  return { configId: option.id, current: option.currentValue, values }
}

/** The effort option as model variants: `''` is the base model. */
export function configEffortVariants(effort: AcpConfigEffort): { available: string[]; current: string } {
  return {
    available: effort.values.filter((v) => v !== CONFIG_EFFORT_DEFAULT),
    current: effort.current === CONFIG_EFFORT_DEFAULT ? '' : effort.current,
  }
}

/**
 * Split a `provider/model/variant` id into the model to select and the
 * variant to set through the effort option. An id the catalog lists as is
 * stays whole, so a model whose own id has three parts is never cut.
 */
export function splitConfigModelId(id: string, catalog: readonly string[]): { model: string; variant: string } {
  if (catalog.includes(id)) return { model: id, variant: '' }
  const cut = id.lastIndexOf('/')
  if (cut > 0 && catalog.includes(id.slice(0, cut))) return { model: id.slice(0, cut), variant: id.slice(cut + 1) }
  return { model: id, variant: '' }
}
