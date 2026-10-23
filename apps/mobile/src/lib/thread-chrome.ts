/**
 * Text for the chat screen's chrome: the header subtitle, the usage line a
 * title tap shows, the model and mode chip, and when a turn shows "Worked for".
 * Same rules and text as Android's `ThreadChromePolicy` and
 * `ThreadComposerPresentationPolicy`.
 */
import { GENERIC_ACP_AGENT_LABELS, isGenericAcpAgent } from '@shared/acp-agents'
import { contextPercent, fmtDuration, formatCostUsd } from '@shared/format'
import type { ProviderSessionStatus, RuntimeMode } from '@shared/provider-events'

/** A turn this long shows "Worked for"; a shorter one shows it on long press. */
export const TURN_DURATION_VISIBLE_MS = 30_000

export function showsTurnDuration(durationMs: number | undefined): boolean {
  return durationMs != null && durationMs >= TURN_DURATION_VISIBLE_MS
}

export const RUNTIME_MODE_LABEL: Record<RuntimeMode, string> = {
  plan: 'Plan',
  sandbox: 'Supervised',
  'accept-edits': 'Auto-accept edits',
  auto: 'Auto',
  'full-access': 'Full access',
}

const STATUS_LABEL: Record<ProviderSessionStatus, string> = {
  running: 'Working',
  connecting: 'Reconnecting',
  error: 'Needs attention',
  idle: 'Ready',
  stopped: 'Stopped',
}

function providerLabel(provider: string): string {
  if (provider === 'claude') return 'Claude'
  if (provider === 'codex') return 'Codex'
  if (provider === 'opencode') return 'OpenCode'
  if (isGenericAcpAgent(provider)) return GENERIC_ACP_AGENT_LABELS[provider].short
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

/** "SSG · Working": the profile (or the agent), then the status. The model is on the composer chip. */
export function threadSubtitle(input: {
  status: ProviderSessionStatus
  cached?: boolean
  instanceName?: string | null
  provider?: string | null
}): string {
  if (input.cached) return 'Saved locally'
  const who = input.instanceName?.trim() || (input.provider?.trim() ? providerLabel(input.provider.trim()) : null)
  return [who, STATUS_LABEL[input.status] ?? input.status].filter(Boolean).join(' · ')
}

export interface ThreadUsage {
  usedTokens?: number
  maxTokens?: number | null
  costUsd?: number
  lastTurnDurationMs?: number
}

function grouped(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function usageParts(usage: ThreadUsage): { tokens: string | null; cost: string | null; lastTurn: string | null } {
  const tokens =
    usage.usedTokens == null
      ? null
      : usage.maxTokens != null
        ? `${grouped(usage.usedTokens)} of ${grouped(usage.maxTokens)} tokens`
        : `${grouped(usage.usedTokens)} tokens`
  return {
    tokens,
    cost: usage.costUsd != null ? formatCostUsd(usage.costUsd) : null,
    lastTurn: usage.lastTurnDurationMs != null ? `last turn ${fmtDuration(usage.lastTurnDurationMs)}` : null,
  }
}

/** "576,511 of 1,000,000 tokens · $904.67 · last turn 1.3s", or null before the first turn reports any. */
export function usageLine(usage: ThreadUsage): string | null {
  const { tokens, cost, lastTurn } = usageParts(usage)
  const parts = [tokens, cost, lastTurn].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The usage line as one spoken sentence: "context 58 percent, 576,511 of 1,000,000 tokens, cost 904.67 dollars, last turn 1.3s". */
export function usageAccessibilityLabel(usage: ThreadUsage): string | null {
  const { tokens, lastTurn } = usageParts(usage)
  const percent = usage.usedTokens != null ? contextPercent(usage.usedTokens, usage.maxTokens) : null
  const parts = [
    percent != null ? `context ${Math.round(percent)} percent` : null,
    tokens,
    usage.costUsd != null ? `cost ${formatCostUsd(usage.costUsd).slice(1)} dollars` : null,
    lastTurn,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : null
}

/** "claude-opus-5-5 · Full access": the model and the mode on one chip. */
export function settingsChipLabel(modelLabel: string | null | undefined, mode: RuntimeMode): string {
  return `${modelLabel?.trim() || 'Model'} · ${RUNTIME_MODE_LABEL[mode]}`
}
