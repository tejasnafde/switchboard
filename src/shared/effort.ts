/**
 * One thinking-effort control for all three agents. Each agent carries effort
 * differently, so this module turns "agent + model + catalog" into the levels
 * the composer offers, and a pick back into what each agent needs:
 *
 *  - Claude: per model, from the SDK's `supportedEffortLevels`; sent as the
 *    query's `effort` and live through `applyFlagSettings`.
 *  - Codex: per model when `model/list` says (`supportedReasoningEfforts`),
 *    else Low / Medium / High; sent per turn.
 *  - OpenCode: the model's variants, which live in the model id
 *    (`provider/model/<variant>`), so a pick rewrites the model.
 */
import { EFFORT_LEVELS, type ModelOption, type ReasoningEffort } from './models'
import { claudeRowCovers, exactRow, type RowCovers } from './model-reconcile'
import { isReasoningEffort } from './provider-option-memory'
import type { AgentType } from './types'

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** What Codex offered before it reported levels per model. */
const CODEX_FALLBACK_LEVELS: ReasoningEffort[] = ['low', 'medium', 'high']

/** Display name for a level. An OpenCode variant may be any string; `''` is its base model. */
export function effortLabel(level: string): string {
  if (!level) return 'Default'
  if (isReasoningEffort(level)) return EFFORT_LABELS[level]
  return level.charAt(0).toUpperCase() + level.slice(1)
}

/**
 * The known levels in a provider's list, weakest first. Entries may be plain
 * strings (Claude) or `{ reasoningEffort }` objects (Codex); anything else is
 * dropped, so a level this build does not know is never offered.
 */
export function parseEffortLevels(raw: unknown): ReasoningEffort[] {
  if (!Array.isArray(raw)) return []
  const named = new Set<unknown>(raw.map((entry) =>
    entry && typeof entry === 'object' ? (entry as { reasoningEffort?: unknown }).reasoningEffort : entry,
  ))
  return EFFORT_LEVELS.filter((level) => named.has(level))
}

/** The effort fields of a Claude SDK `ModelInfo` row. */
export function claudeModelEffort(info: {
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
}): Pick<ModelOption, 'effortLevels'> {
  if (Array.isArray(info.supportedEffortLevels)) return { effortLevels: parseEffortLevels(info.supportedEffortLevels) }
  if (info.supportsEffort === false) return { effortLevels: [] }
  // Supported but no list: the three levels every effort model takes.
  if (info.supportsEffort === true) return { effortLevels: ['low', 'medium', 'high'] }
  return {}
}

/** The catalog row describing `model`: an exact id first, then the provider's own matching rule. */
export function modelRowFor(
  models: readonly ModelOption[],
  model: string | undefined,
  covers: RowCovers = exactRow,
): ModelOption | undefined {
  if (!model) return undefined
  return models.find((row) => row.id === model) ?? models.find((row) => covers(row, model))
}

export interface EffortChoice {
  /** A level for Claude and Codex; an OpenCode variant (`''` = base). */
  value: string
  label: string
  /** The level the provider uses when none is sent. */
  isDefault: boolean
}

export interface EffortControl {
  choices: EffortChoice[]
  /** The choice in effect; `''` when it is the provider's unnamed default. */
  value: string
}

export interface EffortControlInput {
  agentType: AgentType
  /** The chat's model pick; empty means the provider default. */
  model?: string
  /** The model the provider reported it is running, when known. */
  resolvedModel?: string
  models: readonly ModelOption[]
  reasoningEffort?: ReasoningEffort
  /** OpenCode only: what the agent advertised for the selected model. */
  variants?: { available: readonly string[]; current: string }
}

/** The control for this chat, or null when its model offers no levels. */
export function effortControlFor(input: EffortControlInput): EffortControl | null {
  if (input.agentType === 'opencode') {
    const available = input.variants?.available ?? []
    if (available.length === 0) return null
    return {
      // The base model already reads "Default", so no choice carries the tag.
      choices: available.map((v) => ({ value: v, label: effortLabel(v), isDefault: false })),
      value: input.variants?.current ?? '',
    }
  }
  if (input.agentType === 'claude-code') {
    const picked = input.model || input.resolvedModel
    const row = picked
      ? modelRowFor(input.models, picked, claudeRowCovers)
      : input.models.find((m) => m.id === 'default')
    const levels = row?.effortLevels ?? []
    // The SDK documents High as Claude's default effort.
    return levelControl(levels, levels.includes('high') ? 'high' : undefined, input.reasoningEffort)
  }
  if (input.agentType === 'codex') {
    const row = modelRowFor(input.models, input.model)
    const levels = row?.effortLevels ?? CODEX_FALLBACK_LEVELS
    // Medium is what the composer showed before Codex reported a default.
    return levelControl(levels, row?.defaultEffort ?? 'medium', input.reasoningEffort)
  }
  return null
}

function levelControl(
  levels: readonly ReasoningEffort[],
  fallback: ReasoningEffort | undefined,
  stored: ReasoningEffort | undefined,
): EffortControl | null {
  if (levels.length === 0) return null
  const defaultLevel = fallback && levels.includes(fallback) ? fallback : undefined
  return {
    choices: levels.map((level) => ({ value: level, label: EFFORT_LABELS[level], isDefault: level === defaultLevel })),
    // A level the current model does not take (carried over from another
    // model or agent) is not what runs, so the default is shown instead.
    value: stored && levels.includes(stored) ? stored : (defaultLevel ?? ''),
  }
}

/**
 * Strip a variant suffix (`/low`, `/high`) from an OpenCode model id, given
 * the variants the agent advertises. `variant` is `''` for a base model.
 */
export function splitModelVariant(id: string, variants: readonly string[]): { base: string; variant: string } {
  for (const v of variants) {
    if (v && id.endsWith(`/${v}`)) return { base: id.slice(0, -v.length - 1), variant: v }
  }
  return { base: id, variant: '' }
}

export type EffortPick =
  | { kind: 'effort'; effort: ReasoningEffort }
  | { kind: 'model'; model: string }

/** What picking `value` changes: the effort, or for OpenCode the model id. */
export function effortPick(
  agentType: AgentType,
  value: string,
  opencode?: { model: string; available: readonly string[] },
): EffortPick | null {
  if (agentType === 'opencode') {
    if (!opencode) return null
    const { base } = splitModelVariant(opencode.model, opencode.available)
    return { kind: 'model', model: value ? `${base}/${value}` : base }
  }
  return isReasoningEffort(value) ? { kind: 'effort', effort: value } : null
}

/**
 * The effort a Claude query should start with: the chat's choice, unless the
 * catalog says the model does not take it (a level carried over from another
 * model). No catalog row means no evidence, and the CLI downgrades by itself.
 */
export function claudeQueryEffort(
  effort: ReasoningEffort | undefined,
  model: string | undefined,
  models: readonly ModelOption[],
): ReasoningEffort | undefined {
  const row = model ? modelRowFor(models, model, claudeRowCovers) : models.find((m) => m.id === 'default')
  return takenBy(effort, row)
}

/**
 * The effort to put on a Codex turn. Codex has no `max`, and a level its
 * catalog says the model does not take would fail the turn, so either leaves
 * the model's own default in effect.
 */
export function codexWireEffort(
  effort: ReasoningEffort | undefined,
  model: string | undefined,
  models: readonly ModelOption[],
): Exclude<ReasoningEffort, 'max'> | undefined {
  if (effort === 'max') return undefined
  return takenBy(effort, modelRowFor(models, model)) as Exclude<ReasoningEffort, 'max'> | undefined
}

function takenBy(effort: ReasoningEffort | undefined, row: ModelOption | undefined): ReasoningEffort | undefined {
  if (!effort) return undefined
  if (row?.effortLevels && !row.effortLevels.includes(effort)) return undefined
  return effort
}
