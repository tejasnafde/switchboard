/**
 * Claude Code's credential home (`CLAUDE_CONFIG_DIR`). A thin, named facade
 * over `credential-home.ts`, which holds the precedence rules both kinds
 * share - see that module for why the ambient value never survives.
 */

import { applyCredentialHome, canonicalCredentialHome } from './credential-home'

/** Claude's own default credential dir: `~/.claude`, absolute, always. */
export function canonicalClaudeHome(): string {
  return canonicalCredentialHome('claude-code')
}

/** Pin `CLAUDE_CONFIG_DIR` on a spawn env. `oauthDir` wins; otherwise the
 *  instance's own overlay value; otherwise the canonical default. */
export function applyClaudeHome(
  env: Record<string, string>,
  oauthDir: string | null | undefined,
): Record<string, string> {
  return applyCredentialHome(env, 'claude-code', oauthDir)
}
