/**
 * Claude Code's credential home (`CLAUDE_CONFIG_DIR`). A thin, named facade
 * over `credential-home.ts`, which holds the precedence rules both kinds
 * share - see that module for why the ambient value never survives.
 */

import {
  applyCredentialHome,
  canonicalCredentialHome,
  effectiveCredentialHome,
} from './credential-home'

/** Claude's own default credential dir: `~/.claude`, absolute, always. */
export function canonicalClaudeHome(): string {
  return canonicalCredentialHome('claude-code')
}

/** The absolute CLAUDE_CONFIG_DIR for a given oauth_dir. */
export function effectiveClaudeHome(oauthDir: string | null | undefined): string {
  return effectiveCredentialHome('claude-code', oauthDir)
}

/** Pin `CLAUDE_CONFIG_DIR` on a spawn env. `oauthDir` wins; otherwise the
 *  instance's own overlay value; otherwise the canonical default. */
export function applyClaudeHome(
  env: Record<string, string>,
  oauthDir: string | null | undefined,
): Record<string, string> {
  return applyCredentialHome(env, 'claude-code', oauthDir)
}
