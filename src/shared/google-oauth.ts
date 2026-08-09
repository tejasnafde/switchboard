/**
 * Decidable parts of the desktop's Google authorization-code flow.
 *
 * Consent happens on the desktop because Google blocks custom-scheme redirects
 * on Android, so the phone cannot run this flow itself. Shared, not main-only,
 * so the blob shape is one contract rather than two copies. No `node:crypto`
 * here - the phone imports this; the PKCE hash lives in `main/google/pkce.ts`.
 */

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** `cloud-platform` for the tunnel; the other two name the signed-in account. */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/cloud-platform', 'openid', 'email']

/** Google's installed-app redirect. Registered with the client, so it cannot move. */
export const LOOPBACK_PORT = 8123
export const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}`

export interface AuthUrlInput {
  clientId: string
  redirectUri: string
  state: string
  challenge: string
}

export function buildAuthUrl(input: AuthUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // Both required for a refresh token on a repeat grant.
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

export type CallbackResult = { ok: true; code: string } | { ok: false; reason: string }

/** `reason: 'ignore'` is not a failure - closing the server on a stray request
 *  (a favicon fetch, a forged error) would kill the real callback. */
export function parseCallback(rawUrl: string, expectedState: string): CallbackResult {
  const url = new URL(rawUrl, LOOPBACK_REDIRECT)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  const state = url.searchParams.get('state')

  // State first, before the error branch: any open page can hit this port, and
  // one no-cors fetch would otherwise abort a sign-in in flight.
  if (state !== expectedState) return { ok: false, reason: 'ignore' }
  if (error) return { ok: false, reason: error }
  if (!code) return { ok: false, reason: 'no code returned' }
  return { ok: true, code }
}

export interface TokenExchangeInput {
  clientId: string
  clientSecret?: string
  code: string
  verifier: string
  redirectUri: string
}

export function tokenExchangeBody(input: TokenExchangeInput): string {
  const body = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
  })
  // Absent, not empty: a blank secret fails as `invalid_client`.
  if (input.clientSecret) body.set('client_secret', input.clientSecret)
  return body.toString()
}

export interface GoogleCredentials {
  clientId: string
  clientSecret?: string
  refreshToken: string
}

/** The exact payload the phone's `parseCredentialBlob` accepts. */
export function credentialBlob(creds: GoogleCredentials): string {
  return JSON.stringify({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken: creds.refreshToken,
  })
}

/** Reverse of `credentialBlob`. Null on a bare refresh token: that form needs
 *  a client id from elsewhere, which only the phone has. */
export function parseCredentialJson(raw: string): GoogleCredentials | null {
  const text = raw.trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const clientId = typeof parsed.clientId === 'string' ? parsed.clientId.trim() : ''
    const refreshToken = typeof parsed.refreshToken === 'string' ? parsed.refreshToken.trim() : ''
    const clientSecret = typeof parsed.clientSecret === 'string' ? parsed.clientSecret.trim() : ''
    if (!clientId || !refreshToken) return null
    return { clientId, refreshToken, clientSecret: clientSecret || undefined }
  } catch {
    // Validator, not an error path. Logging would echo credential fragments.
    return null
  }
}

/** Google's look like `1//0g...`. Fails a mis-paste here, not at the endpoint. */
export function isBareRefreshToken(raw: string): boolean {
  return raw.trim().startsWith('1//')
}

export interface PartialClientConfig {
  clientId?: string
  clientSecret?: string
}

export interface ClientConfig {
  clientId: string
  clientSecret?: string
}

/** Environment first, then saved settings. A source with no client id is
 *  skipped: a blank one reaches Google as `invalid_client`. */
export function resolveClientConfig(sources: {
  env: PartialClientConfig
  settings: PartialClientConfig
}): ClientConfig | null {
  for (const source of [sources.env, sources.settings]) {
    const clientId = source.clientId?.trim()
    if (clientId) return { clientId, clientSecret: source.clientSecret?.trim() || undefined }
  }
  return null
}
