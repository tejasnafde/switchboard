import type { AgentType } from './types'

export interface ModelOption {
  id: string
  label: string
  tier: 'fast' | 'balanced' | 'max'
}

export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'fast' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tier: 'balanced' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', tier: 'max' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'max' },
]

/**
 * Codex models — mirrors the Codex desktop app's model picker. The Codex
 * app-server accepts these IDs directly via the `model` param on
 * thread/start / turn/start. Order matches the desktop app's picker (most
 * recent frontier first).
 *
 * Reasoning effort is a SEPARATE selector (`ReasoningEffort` below) — the
 * Codex app surfaces it next to the model dropdown, not as model variants.
 */
export const CODEX_MODELS: ModelOption[] = [
  { id: 'gpt-5.4', label: 'GPT-5.4', tier: 'max' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2-Codex', tier: 'balanced' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1-Codex-Max', tier: 'max' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', tier: 'fast' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', tier: 'balanced' },
  { id: 'gpt-5.2', label: 'GPT-5.2', tier: 'balanced' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1-Codex-Mini', tier: 'fast' },
]

/**
 * OpenCode models — popular NVIDIA NIM free-tier models + common
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
