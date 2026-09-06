/**
 * Resolve the spawn env for a provider instance. Lives here rather than in
 * `ipc/` because the Settings Test probe and the usage probe both need it,
 * and routing it through the IPC module would make those import in a cycle.
 */

import type { ProviderInstanceRow } from '../db/providerInstances'
import { buildClaudeCliEnv } from './adapters/claude-adapter'
import { buildCodexCliEnv } from './adapters/codex-adapter'
import { applyEnvOverlay } from './env-overlay'
import { applyCredentialHome } from './credential-home'

/**
 * Base CLI env, then the instance's decrypted overlay, then the credential
 * home. Order matters, and it is the same for both credential-bearing kinds:
 *
 *     instance oauth_dir  >  instance env overlay  >  canonical default
 *                                                     (never the ambient env)
 *
 * The overlay is applied FIRST so `applyCredentialHome` can see a legacy
 * env-mode profile's own `CODEX_HOME` / `CLAUDE_CONFIG_DIR` (rule 2) while an
 * explicit `oauthDir` still outranks it. The ambient value is already gone by
 * then - `buildCodexCliEnv` / `buildClaudeCliEnv` replace it with the
 * canonical default - so nothing the launching shell exported can win.
 * The adapters share `applyCredentialHome` with this seam, so the spawn path
 * and the Test/usage probes cannot drift apart.
 */
export function resolveInstanceEnv(instance: ProviderInstanceRow): Record<string, string> {
  const env: Record<string, string> = instance.agentType === 'codex'
    ? buildCodexCliEnv()
    : instance.agentType === 'claude-code'
      ? buildClaudeCliEnv()
      : { ...(process.env as Record<string, string>) }
  applyEnvOverlay(env, instance.env)
  // Resolved for EVERY instance of a credential-bearing kind, not just
  // oauth_dir ones: an instance with no dir of its own must land on the
  // canonical default rather than inherit the ambient home of whatever
  // launched us.
  if (instance.agentType === 'codex' || instance.agentType === 'claude-code') {
    applyCredentialHome(env, instance.agentType, instance.oauthDir)
  }
  return env
}
