import { EFFORT_LEVELS, type ReasoningEffort } from './models'

/**
 * The model and reasoning effort a conversation last used on each agent
 * type, so switching back to a provider restores them instead of that
 * provider's default. Stored per conversation as JSON
 * (`conversations.provider_options_json`).
 */
export interface ProviderOptions {
  model?: string
  reasoningEffort?: ReasoningEffort
}
export type ProviderOptionMemory = Record<string, ProviderOptions>

const EFFORTS = new Set<unknown>(EFFORT_LEVELS)

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return EFFORTS.has(value)
}

export function normalizeProviderOptionMemory(raw: unknown): ProviderOptionMemory {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ProviderOptionMemory = {}
  for (const [agent, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const { model, reasoningEffort } = value as Record<string, unknown>
    const options: ProviderOptions = {}
    if (typeof model === 'string' && model) options.model = model
    if (isReasoningEffort(reasoningEffort)) options.reasoningEffort = reasoningEffort
    out[agent] = options
  }
  return out
}

/**
 * Remember what the chat used on `from.agentType`, then pick the options for
 * `to`: its remembered model (null means the provider default) and its
 * remembered effort, else the effort the chat has now.
 */
export function switchProviderOptions(
  memory: ProviderOptionMemory,
  from: { agentType: string | null; model: string | null; reasoningEffort: ReasoningEffort | null },
  to: string,
): { memory: ProviderOptionMemory; model: string | null; reasoningEffort: ReasoningEffort | null } {
  const next = { ...memory }
  if (from.agentType) {
    next[from.agentType] = {
      ...(from.model ? { model: from.model } : {}),
      ...(from.reasoningEffort ? { reasoningEffort: from.reasoningEffort } : {}),
    }
  }
  const target = next[to]
  return {
    memory: next,
    model: target?.model ?? null,
    reasoningEffort: target?.reasoningEffort ?? from.reasoningEffort,
  }
}
