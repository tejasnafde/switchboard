/**
 * Claude subscription usage, read from `GET /api/oauth/usage`.
 *
 * Deliberately never refreshes the OAuth token: the CLI rotates it and writes
 * it back, and clears a dead refresh token, so refreshing here would race the
 * CLI and can log the user out. Expiry is checked locally and reported. A 401
 * on a token that had not expired means revocation or a missing scope, which
 * a refresh would not fix either.
 */

import { oauthLoginCommand } from '@shared/provider-auth-format'
import { parseClaudeUsage } from '@shared/claude-usage-parse'
import type { ProviderUsage } from '@shared/provider-usage'
import { createMainLogger } from '../../logger'
import { readClaudeCredential } from './claude-keychain'
import { redactSecrets } from './redact'

const log = createMainLogger('provider:usage-claude')

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const REQUEST_TIMEOUT_MS = 8000
/** Treat a token inside this window as already expired. */
const EXPIRY_SKEW_MS = 60_000
/** The endpoint is gated on this scope; without it the API reports no limits. */
const REQUIRED_SCOPE = 'user:profile'

/**
 * Env vars that mean plan limits do not apply. Checked against the resolved
 * spawn env rather than the instance's `auth_mode` column, which is UI-only
 * state the main process never reads: an 'env' instance with no key is still
 * OAuth, and an 'oauth_dir' instance can retain an injected API key.
 */
const NON_SUBSCRIPTION_ENV: Array<[string, string]> = [
  ['ANTHROPIC_API_KEY', 'this instance authenticates with an API key'],
  ['ANTHROPIC_AUTH_TOKEN', 'this instance authenticates with a bearer token'],
  ['ANTHROPIC_BASE_URL', 'this instance points at a custom API base URL'],
  ['CLAUDE_CODE_USE_BEDROCK', 'this instance runs through Amazon Bedrock'],
  ['CLAUDE_CODE_USE_VERTEX', 'this instance runs through Google Vertex AI'],
]

function base(instanceId: string, fetchedAtMs: number): ProviderUsage {
  return {
    instanceId,
    agentType: 'claude-code',
    status: 'error',
    plan: null,
    account: null,
    windows: [],
    overage: [],
    fetchedAtMs,
  }
}

export async function fetchClaudeUsage(
  instanceId: string,
  env: Record<string, string>,
  oauthDir: string | null,
): Promise<ProviderUsage> {
  const now = Date.now()
  const result = base(instanceId, now)

  for (const [key, reason] of NON_SUBSCRIPTION_ENV) {
    if (env[key]) {
      return { ...result, status: 'not-applicable', message: `Plan limits do not apply - ${reason}.` }
    }
  }

  const configDir = env.CLAUDE_CONFIG_DIR ?? null
  const loginCommand = oauthLoginCommand('claude-code', oauthDir || configDir || '~/.claude')

  const credential = await readClaudeCredential(configDir)
  if (credential.kind === 'unsupported') {
    return { ...result, status: 'unsupported', message: credential.message }
  }
  if (credential.kind === 'error') {
    return { ...result, status: 'error', message: credential.message }
  }
  if (credential.kind === 'missing') {
    return {
      ...result,
      status: 'unauthenticated',
      message: credential.message,
      ...(loginCommand ? { command: loginCommand } : {}),
    }
  }

  const { accessToken, expiresAtMs, subscriptionType, scopes } = credential.credential
  const plan = subscriptionType

  if (expiresAtMs !== null && expiresAtMs - EXPIRY_SKEW_MS <= now) {
    return {
      ...result,
      status: 'expired',
      plan,
      message: `The stored login for this instance expired at ${new Date(expiresAtMs).toLocaleString()}. Run a turn with this instance, or run the login command, to refresh it.`,
      ...(loginCommand ? { command: loginCommand } : {}),
    }
  }

  if (scopes.length > 0 && !scopes.includes(REQUIRED_SCOPE)) {
    return {
      ...result,
      status: 'not-applicable',
      plan,
      message: `This login is missing the ${REQUIRED_SCOPE} scope, which plan usage reporting requires.`,
      ...(loginCommand ? { command: loginCommand } : {}),
    }
  }

  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    // Redacted: this message is not ours, and it is rendered in the UI.
    const message = redactSecrets(err instanceof Error ? err.message : String(err))
    log.warn(`usage request failed: ${message}`)
    return { ...result, status: 'error', plan, message: `Could not reach the usage endpoint: ${message}` }
  }

  if (response.status === 401 || response.status === 403) {
    // The token had not expired, so this is revocation or a scope problem.
    return {
      ...result,
      status: 'unauthenticated',
      plan,
      message: 'The stored login was rejected. It may have been revoked, or it may lack the scope needed for usage reporting.',
      ...(loginCommand ? { command: loginCommand } : {}),
    }
  }
  if (!response.ok) {
    log.warn(`usage endpoint returned ${response.status}`)
    return { ...result, status: 'error', plan, message: `Usage endpoint returned HTTP ${response.status}.` }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ...result, status: 'error', plan, message: 'Usage endpoint returned a body that was not JSON.' }
  }

  const parsed = parseClaudeUsage(body)
  if (!parsed.ok) {
    return { ...result, status: 'error', plan, message: parsed.error ?? 'Usage response could not be parsed.' }
  }
  if (parsed.windows.length === 0 && parsed.overage.length === 0) {
    return { ...result, status: 'not-applicable', plan, message: 'No plan limits are reported for this account.' }
  }

  return {
    ...result,
    status: 'ok',
    plan,
    windows: parsed.windows,
    overage: parsed.overage,
  }
}
