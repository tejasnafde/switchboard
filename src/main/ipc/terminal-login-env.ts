/**
 * Resolves `TerminalCreateOptions.loginInstance` (identity only: agentType +
 * instanceId) into that provider instance's real spawn env, entirely in
 * main. Backs the Terminal-tab "Start Terminal Session" login flow in
 * UnifiedProviderPicker.tsx.
 *
 * The renderer must never build CODEX_HOME/CLAUDE_CONFIG_DIR itself (it
 * used to, and only for Claude - Codex logins silently ran against
 * whatever ambient CODEX_HOME happened to be set). Routing identity
 * through this seam instead means main - via the same
 * `resolveProviderInstance` + `resolveInstanceEnv` the real session spawn
 * and Settings "Test" probe use - is the single source of truth for which
 * credential home a login terminal gets.
 */
import type { TerminalCreateOptions } from '@shared/types'
import { resolveProviderInstance } from '../db/providerInstances'
import { resolveInstanceEnv } from '../provider/instance-env'

/**
 * Thrown when the renderer named a specific instance main can't resolve
 * (wrong kind, disabled, or unknown id). Callers must surface this to the
 * user rather than silently opening a shell scoped to the wrong - or no -
 * account.
 */
export class TerminalLoginInstanceError extends Error {}

/**
 * Env keys a login terminal's credential home hinges on. A renderer/launch-
 * config env value for one of these must never win over what main resolved
 * for the requested instance - that would let a stale/forged env value
 * silently point the shell at a different account's credentials. Every
 * other var still merges normally (opts.env can add or override them).
 */
const CREDENTIAL_ENV_KEYS = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const

export function withResolvedLoginEnv(opts: TerminalCreateOptions): TerminalCreateOptions {
  const identity = opts.loginInstance
  if (!identity) return opts

  let instance
  try {
    instance = resolveProviderInstance(identity.agentType, identity.instanceId)
  } catch (err) {
    throw new TerminalLoginInstanceError(err instanceof Error ? err.message : String(err))
  }
  if (!instance) {
    throw new TerminalLoginInstanceError(
      `No enabled ${identity.agentType} instance available to log in with.`,
    )
  }

  const loginEnv = resolveInstanceEnv(instance)
  const env: Record<string, string> = { ...loginEnv, ...(opts.env ?? {}) }
  for (const key of CREDENTIAL_ENV_KEYS) {
    if (key in loginEnv) env[key] = loginEnv[key]
  }
  return { ...opts, env }
}
