/**
 * Codex's credential home (`CODEX_HOME`). A thin, named facade over
 * `credential-home.ts`, which holds the precedence rules both kinds share -
 * see that module for why the ambient value never survives.
 */

import {
  applyCredentialHome,
  canonicalCredentialHome,
  effectiveCredentialHome,
} from './credential-home'

/** Codex's own default credential dir: `~/.codex`, absolute, always. */
export function canonicalCodexHome(): string {
  return canonicalCredentialHome('codex')
}

/** The absolute CODEX_HOME for a given oauth_dir. */
export function effectiveCodexHome(oauthDir: string | null | undefined): string {
  return effectiveCredentialHome('codex', oauthDir)
}

/** Pin `CODEX_HOME` on a spawn env. `oauthDir` wins; otherwise the instance's
 *  own overlay value; otherwise the canonical default. */
export function applyCodexHome(
  env: Record<string, string>,
  oauthDir: string | null | undefined,
): Record<string, string> {
  return applyCredentialHome(env, 'codex', oauthDir)
}
