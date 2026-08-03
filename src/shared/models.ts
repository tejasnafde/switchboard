import type { AgentType } from './types'

export interface ModelOption {
  id: string
  label: string
  tier: 'fast' | 'balanced' | 'max'
}

/**
 * Shown BEFORE a session exists, on both desktop and mobile - `provider:list-models`
 * needs a live session to answer, so neither client can do better than a static
 * list here. Once a session starts, the adapter's `model.variants` event replaces
 * it with what that account actually has.
 *
 * Verified 2026-08-03 against the ids in the Claude Code binary the adapter
 * spawns (2.1.220), not from memory. Newest first; the 4.5-era ids were dropped
 * because their successors cost the same. An id already stored on a session
 * still works - this list only decides what the picker OFFERS.
 */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-fable-5', label: 'Claude Fable 5', tier: 'max' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', tier: 'max' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', tier: 'max' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'max' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'balanced' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'balanced' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'fast' },
]

/**
 * Codex models.
 *
 * Unlike Claude, the Codex adapter has NO live model list - it never emits
 * `model.variants` - so this array is the only list the picker ever shows. A
 * stale entry here is a model the user simply cannot pick.
 *
 * Verified 2026-08-03 against the model catalog embedded in the codex binary
 * (codex-cli 0.144.1), taking exactly the entries marked `"visibility": "list"`.
 * Tiers come from that catalog's own descriptions, not from a guess:
 * Sol "latest frontier", Terra "balanced ... everyday work", Luna "fast and
 * affordable".
 *
 * The `-codex` slugs that used to be listed here (5.1-codex-max, 5.1-codex-mini,
 * 5.2-codex, 5.3-codex) are absent from that catalog. They still appear as
 * strings in the binary, so they are probably accepted for back-compat, but
 * Codex's own picker does not offer them and neither should ours.
 *
 * Reasoning effort is a SEPARATE selector (`ReasoningEffort` below).
 */
export const CODEX_MODELS: ModelOption[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', tier: 'max' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', tier: 'balanced' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', tier: 'fast' },
  { id: 'gpt-5.5', label: 'GPT-5.5', tier: 'max' },
  { id: 'gpt-5.4', label: 'GPT-5.4', tier: 'max' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', tier: 'fast' },
  { id: 'gpt-5.2', label: 'GPT-5.2', tier: 'balanced' },
]

/**
 * OpenCode models - popular NVIDIA NIM free-tier models + common
 * OpenCode-compatible providers. Users can type any model ID supported by
 * their opencode provider config (e.g. "nvidia-nim/deepseek-ai/deepseek-r1").
 *
 * Model IDs use OpenCode's `provider/model` format matching the provider
 * block in ~/.config/opencode/opencode.json.
 */
export const OPENCODE_MODELS: ModelOption[] = [
  // NVIDIA NIM free tier
  { id: 'nvidia-nim/z-ai/glm-5.1', label: 'GLM 5.1 (NVIDIA, free)', tier: 'max' },
  { id: 'nvidia-nim/moonshotai/kimi-k2.5', label: 'Kimi K2.5 (NVIDIA, free)', tier: 'max' },
  { id: 'nvidia-nim/minimaxai/minimax-m2.7', label: 'MiniMax M2.7 (NVIDIA, free)', tier: 'balanced' },
  { id: 'nvidia-nim/deepseek-ai/deepseek-v3_2', label: 'DeepSeek V3.2 (NVIDIA, free)', tier: 'balanced' },
  // Google Gemini (requires GEMINI_API_KEY in Settings → Providers)
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'max' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'balanced' },
  { id: 'google/gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash (exp)', tier: 'fast' },
  { id: 'google/gemini-2.0-flash-thinking-exp', label: 'Gemini 2.0 Flash Thinking', tier: 'balanced' },
  { id: 'google/gemini-1.5-pro', label: 'Gemini 1.5 Pro', tier: 'balanced' },
  { id: 'google/gemini-1.5-flash', label: 'Gemini 1.5 Flash', tier: 'fast' },
]

/**
 * Codex-only reasoning-effort selector. Codex desktop shows this as a
 * second dropdown next to the model picker (Low / Medium / High). Maps to
 * the `reasoningEffort` field on turn/start params when supported.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high'

export const REASONING_EFFORTS: Array<{ id: ReasoningEffort; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
]

export function modelsForAgent(agent: AgentType): ModelOption[] {
  if (agent === 'codex') return CODEX_MODELS
  if (agent === 'opencode') return OPENCODE_MODELS
  return CLAUDE_MODELS
}

export function defaultModelFor(agent: AgentType): string {
  if (agent === 'codex') return CODEX_MODELS[0].id
  if (agent === 'opencode') return OPENCODE_MODELS[0].id // GLM 5.1
  return CLAUDE_MODELS[1].id
}

/**
 * Does this agent support a separate reasoning-effort selector?
 * Today only Codex surfaces it as a UI control.
 */
export function agentSupportsReasoningEffort(agent: AgentType): boolean {
  return agent === 'codex'
}
