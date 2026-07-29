/**
 * Resolve the spawn env for a provider instance. Lives here rather than in
 * `ipc/` because the Settings Test probe and the usage probe both need it,
 * and routing it through the IPC module would make those import in a cycle.
 */

import type { ProviderInstanceRow } from '../db/providerInstances'
import { buildClaudeCliEnv } from './adapters/claude-adapter'
import { buildCodexCliEnv } from './adapters/codex-adapter'
import { applyEnvOverlay } from './env-overlay'

/**
 * Base CLI env, then the instance's decrypted overlay, then the oauth dir.
 * Order matters: the overlay goes first so an explicit `oauthDir` wins over a
 * `CLAUDE_CONFIG_DIR` typed into the env list, matching the adapters.
 */
export function resolveInstanceEnv(instance: ProviderInstanceRow): Record<string, string> {
  const env: Record<string, string> = instance.agentType === 'codex'
    ? buildCodexCliEnv()
    : instance.agentType === 'claude-code'
      ? buildClaudeCliEnv()
      : { ...(process.env as Record<string, string>) }
  applyEnvOverlay(env, instance.env)
  if (instance.oauthDir && instance.oauthDir.length > 0) {
    if (instance.agentType === 'claude-code') env.CLAUDE_CONFIG_DIR = instance.oauthDir
    if (instance.agentType === 'codex') env.CODEX_HOME = instance.oauthDir
  }
  return env
}
