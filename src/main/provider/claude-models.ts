import { claudeModelEffort } from '@shared/effort'
import { inferModelTier, type ModelOption } from '@shared/models'

/** The parts of the SDK's `ModelInfo` the pickers use. */
export interface ClaudeModelInfo {
  value: string
  displayName: string
  resolvedModel?: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
}

/**
 * A live Claude catalog as picker rows. `value` verbatim: a live row is an
 * alias (`sonnet`, `opus[1m]`), and rewriting it to a full id would name a
 * model the CLI did not. `resolvedModel` is the CLI's OWN mapping when it
 * supplies one - reconcileSelectedModel uses it to recognise a persisted
 * explicit id. The effort levels ride along so the composer offers only
 * what each model takes.
 */
export function claudeModelOptions(models: readonly ClaudeModelInfo[]): ModelOption[] {
  return models.map((m) => ({
    id: m.value,
    label: m.displayName,
    tier: inferModelTier(m.value),
    ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
    ...claudeModelEffort(m),
  }))
}
