/**
 * Marks the env of every agent CLI Switchboard starts, so a Switchboard that
 * agent launches (npm run dev, an e2e or smoke run) opens its windows in the
 * background without anyone having to export a flag. Claude Code already
 * sets CLAUDECODE=1 for its tools; Codex and OpenCode set nothing we can rely
 * on. Only agent processes carry it: the user's own terminals do not, so a
 * Switchboard the user starts by hand still comes to the front.
 */
export const SWITCHBOARD_AGENT_ENV = 'SWITCHBOARD_AGENT'

export function markAgentSpawnEnv<T extends Record<string, string | undefined>>(env: T): T {
  return { ...env, [SWITCHBOARD_AGENT_ENV]: '1' }
}

/**
 * Whether a Switchboard process should open in the background (macOS):
 * SB_E2E_BACKGROUND wins when set ('1' on, anything else off); otherwise on
 * when an agent launched it.
 */
export function backgroundByDefault(env: Record<string, string | undefined>): boolean {
  if (env.SB_E2E_BACKGROUND !== undefined) return env.SB_E2E_BACKGROUND === '1'
  return env.CLAUDECODE === '1' || env[SWITCHBOARD_AGENT_ENV] === '1'
}
