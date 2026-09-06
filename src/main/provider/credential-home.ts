/**
 * The single place that decides which credential home a provider CLI runs
 * under - `CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude Code.
 *
 * Both CLIs keep their OAuth tokens in a directory named by one env var, so
 * that variable *is* the account identity of every session, usage probe and
 * Settings "Test" run. Three rules make multi-account profiles hold, and they
 * are identical for both kinds - the asymmetry (Codex pinned, Claude
 * inheriting) is what let a `CLAUDE_CONFIG_DIR` exported in a shell profile
 * silently own every "Default" Claude session:
 *
 *  1. The instance's own `oauth_dir` always wins, canonicalized to an
 *     absolute path first - `~/.codex-work`, `/tmp/x/../x` and `/tmp/x/` must
 *     all reach the same directory the user logged into.
 *  2. Failing that, a home named in the instance's OWN decrypted env overlay
 *     wins. That is a legacy env-mode profile whose structural var predates
 *     the oauth_dir field; it is deliberate per-instance configuration, and
 *     moving it to the default would switch the user's account without
 *     telling them. It is canonicalized like an oauth_dir, and only the var
 *     belonging to THIS agent kind counts (a stray `CODEX_HOME` on a Claude
 *     instance is ordinary env, not an identity).
 *  3. Otherwise the canonical default (`~/.claude`, `~/.codex`) - never
 *     whatever the ambient process env holds. That value is a leftover,
 *     inherited from the launching shell or from a previous profile, and
 *     letting it through is how every live instance collapsed onto one
 *     account.
 *
 * Rule 3 is enforced at the base-env seam (`buildCodexCliEnv` /
 * `buildClaudeCliEnv` overwrite the ambient value with the canonical default
 * before any overlay is applied), so by the time `applyCredentialHome` runs,
 * anything still in `env[name]` came from the instance itself.
 *
 * The spawn paths (codex-adapter, claude-adapter) and the shared
 * `resolveInstanceEnv` seam all apply this, so they cannot drift apart.
 */

import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { canonicalizeOauthPath } from './oauth-path'

/** Agent kinds whose credentials live in a directory named by an env var. */
export type CredentialHomeAgent = 'claude-code' | 'codex'

const HOME_ENV: Record<CredentialHomeAgent, 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'> = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
}

const DEFAULT_DIR_NAME: Record<CredentialHomeAgent, string> = {
  'claude-code': '.claude',
  codex: '.codex',
}

/** The env var that names this kind's credential home. */
export function credentialHomeEnvName(
  agentType: CredentialHomeAgent,
): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' {
  return HOME_ENV[agentType]
}

/** The CLI's own default credential dir (`~/.claude`, `~/.codex`), absolute. */
export function canonicalCredentialHome(agentType: CredentialHomeAgent): string {
  return join(homedir(), DEFAULT_DIR_NAME[agentType])
}

/**
 * The absolute credential home for a given directory. Blank/unset falls back
 * to the canonical default; a legacy relative row is anchored to the home dir
 * rather than to whatever cwd the child inherits.
 */
export function effectiveCredentialHome(
  agentType: CredentialHomeAgent,
  dir: string | null | undefined,
): string {
  const canonical = canonicalizeOauthPath(dir)
  if (!canonical) return canonicalCredentialHome(agentType)
  return isAbsolute(canonical) ? canonical : resolve(homedir(), canonical)
}

/**
 * Pin the credential home on a spawn env, applying the precedence above.
 * `env[name]` is read as the already-applied instance overlay (rule 2), which
 * is why callers must overlay BEFORE calling this.
 */
export function applyCredentialHome(
  env: Record<string, string>,
  agentType: CredentialHomeAgent,
  oauthDir: string | null | undefined,
): Record<string, string> {
  const name = credentialHomeEnvName(agentType)
  const explicit = canonicalizeOauthPath(oauthDir)
  env[name] = effectiveCredentialHome(agentType, explicit || env[name])
  return env
}

/**
 * The home an instance really resolves to, without building a spawn env -
 * for validation (two profiles must not share one credential store) and for
 * the wire shape Settings displays. Same precedence, same canonicalization.
 */
export function resolvedCredentialHome(
  agentType: CredentialHomeAgent,
  oauthDir: string | null | undefined,
  env: Record<string, string> | undefined,
): string {
  const explicit = canonicalizeOauthPath(oauthDir)
  if (explicit) return effectiveCredentialHome(agentType, explicit)
  return effectiveCredentialHome(agentType, env?.[credentialHomeEnvName(agentType)])
}
