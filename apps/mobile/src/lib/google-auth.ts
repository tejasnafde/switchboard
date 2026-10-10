/**
 * Google credentials yielding a cloud-platform access token for the IAP relay.
 * The phone never runs a browser sign-in: it imports a refresh token minted on
 * the desktop and refreshes it against the token endpoint directly. Endpoints
 * are inline to keep a discovery round trip off cold start; tokens live in
 * expo-secure-store.
 */
import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { createLogger } from '@shared/logger'
import { isBareRefreshToken, parseCredentialJson } from '@shared/google-oauth'

const log = createLogger('google-auth')

export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

/** Treat a token as stale this long before its real expiry. */
export const EXPIRY_SKEW_MS = 60_000

const KEY_REFRESH_TOKEN = 'sb.google.refresh_token'
const KEY_ACCESS_TOKEN = 'sb.google.access_token'
const KEY_EXPIRES_AT = 'sb.google.expires_at'
const KEY_EMAIL = 'sb.google.email'
const KEY_CLIENT_ID = 'sb.google.client_id'
const KEY_CLIENT_SECRET = 'sb.google.client_secret'

interface GoogleClientConfig {
  clientId: string
  clientSecret?: string
}

/**
 * From Expo config `extra`; real values in Secret Manager, never committed.
 * Client TYPE matters - see the README. Android/iOS clients have no secret,
 * hence clientSecret being optional.
 */
function readClientConfig(): GoogleClientConfig | null {
  // Credentials imported from the desktop win: that flow uses the Desktop-type
  // client over a loopback redirect, which is the only browser flow Google
  // still permits for this app (custom URI schemes are blocked on Android).
  if (storedClientId) {
    return { clientId: storedClientId, clientSecret: storedClientSecret ?? undefined }
  }
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>
  const clientId = typeof extra.googleClientId === 'string' ? extra.googleClientId.trim() : ''
  const clientSecret = typeof extra.googleClientSecret === 'string' ? extra.googleClientSecret.trim() : ''
  if (!clientId || clientId.startsWith('REPLACE_ME')) {
    log.error('extra.googleClientId is not configured in app.json')
    return null
  }
  return { clientId, clientSecret: clientSecret || undefined }
}

// ---------------------------------------------------------------------------
// Pure helpers (no native modules, no network).
// ---------------------------------------------------------------------------

/**
 * A token is stale once it is inside the skew window, so callers never hand a
 * token to the IAP relay that dies mid-handshake.
 */
export function isStale(expiresAt: number, now: number = Date.now()): boolean {
  return expiresAt - now <= EXPIRY_SKEW_MS
}

/** `expires_in` (seconds, relative) to an absolute epoch-ms deadline. */
export function expiresAtFrom(expiresInSeconds: number, now: number = Date.now()): number {
  return now + expiresInSeconds * 1000
}

function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

/**
 * Read the `email` claim out of an id_token WITHOUT verifying the signature.
 * Display only: it decides what string appears on the sign-in screen, never
 * whether a request is authorized. The access token is the only credential that
 * carries authority here, and Google validates that server-side.
 */
export function emailFromIdToken(idToken: string): string | null {
  const payload = idToken.split('.')[1]
  if (!payload) return null
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as {
      email?: unknown
    }
    return typeof json.email === 'string' ? json.email : null
  } catch (err) {
    log.warn('could not parse id_token payload', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string
  expiresAt: number
}

let cached: CachedToken | null = null
let refreshTokenValue: string | null = null
let signedInEmail: string | null = null
/** Client credentials imported from the desktop, which win over app.json. */
let storedClientId: string | null = null
let storedClientSecret: string | null = null
/** Single-flight guards: one hydrate, one refresh, however many callers. */
let hydration: Promise<void> | null = null
let refreshInFlight: Promise<string | null> | null = null

async function readKeys(): Promise<void> {
  const [refresh, access, expires, email, clientId, clientSecret] = await Promise.all([
    SecureStore.getItemAsync(KEY_REFRESH_TOKEN),
    SecureStore.getItemAsync(KEY_ACCESS_TOKEN),
    SecureStore.getItemAsync(KEY_EXPIRES_AT),
    SecureStore.getItemAsync(KEY_EMAIL),
    SecureStore.getItemAsync(KEY_CLIENT_ID),
    SecureStore.getItemAsync(KEY_CLIENT_SECRET),
  ])
  refreshTokenValue = refresh
  signedInEmail = email
  storedClientId = clientId
  storedClientSecret = clientSecret
  const expiresAt = expires ? Number(expires) : NaN
  cached = access && Number.isFinite(expiresAt) ? { accessToken: access, expiresAt } : null
}

/** Load SecureStore into memory once; concurrent callers share the same read. */
function hydrate(): Promise<void> {
  if (!hydration) {
    hydration = readKeys().catch((err) => {
      log.error('reading stored google credentials failed', err)
      // Leave hydration resolved: a broken keychain read should surface as
      // "not signed in", not as a permanently rejected promise every call.
    })
  }
  return hydration
}

async function persist(state: {
  accessToken: string
  expiresAt: number
  refreshToken?: string
  email?: string | null
}): Promise<void> {
  cached = { accessToken: state.accessToken, expiresAt: state.expiresAt }
  if (state.refreshToken) refreshTokenValue = state.refreshToken
  if (state.email) signedInEmail = state.email
  try {
    await Promise.all([
      SecureStore.setItemAsync(KEY_ACCESS_TOKEN, state.accessToken),
      SecureStore.setItemAsync(KEY_EXPIRES_AT, String(state.expiresAt)),
      state.refreshToken ? SecureStore.setItemAsync(KEY_REFRESH_TOKEN, state.refreshToken) : Promise.resolve(),
      state.email ? SecureStore.setItemAsync(KEY_EMAIL, state.email) : Promise.resolve(),
    ])
  } catch (err) {
    // In-memory state is still good, so the session survives until app exit.
    log.error('persisting google credentials failed', err)
  }
}

async function clearStoredCredentials(): Promise<void> {
  cached = null
  refreshTokenValue = null
  signedInEmail = null
  storedClientId = null
  storedClientSecret = null
  hydration = Promise.resolve()
  for (const key of [
    KEY_ACCESS_TOKEN,
    KEY_EXPIRES_AT,
    KEY_REFRESH_TOKEN,
    KEY_EMAIL,
    KEY_CLIENT_ID,
    KEY_CLIENT_SECRET,
  ]) {
    try {
      await SecureStore.deleteItemAsync(key)
    } catch (err) {
      log.warn(`deleting ${key} failed`, err)
    }
  }
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  id_token?: string
  error?: string
  error_description?: string
}

async function postToken(fields: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode(fields),
  })
  const text = await res.text()
  let body: TokenResponse
  try {
    body = JSON.parse(text) as TokenResponse
  } catch (err) {
    log.error(`token endpoint returned non-JSON (http ${res.status})`, err)
    throw new Error(`Google token endpoint returned HTTP ${res.status}`)
  }
  if (!res.ok || body.error) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`
    log.error('token endpoint rejected the request', detail)
    throw new TokenEndpointError(detail, body.error ?? null)
  }
  return body
}

export class TokenEndpointError extends Error {
  readonly code: string | null
  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'TokenEndpointError'
    this.code = code
  }
}

async function doRefresh(): Promise<string | null> {
  const config = readClientConfig()
  if (!config || !refreshTokenValue) return null
  const fields: Record<string, string> = {
    client_id: config.clientId,
    refresh_token: refreshTokenValue,
    grant_type: 'refresh_token',
  }
  if (config.clientSecret) fields.client_secret = config.clientSecret

  try {
    const body = await postToken(fields)
    if (!body.access_token || typeof body.expires_in !== 'number') {
      log.error('refresh response missing access_token/expires_in')
      return null
    }
    // Google does not reissue a refresh token on refresh; keep the stored one.
    await persist({
      accessToken: body.access_token,
      expiresAt: expiresAtFrom(body.expires_in),
      email: body.id_token ? emailFromIdToken(body.id_token) : null,
    })
    log.info('access token refreshed')
    return body.access_token
  } catch (err) {
    // invalid_grant means the refresh token is dead (revoked, password change,
    // or the 7-day expiry an unpublished "Testing" OAuth app hands out). Wipe
    // it so the UI shows "signed out" instead of retrying forever.
    if (err instanceof TokenEndpointError && err.code === 'invalid_grant') {
      log.warn('refresh token rejected, clearing stored credentials')
      await clearStoredCredentials()
      return null
    }
    log.error('refreshing the access token failed', err)
    return null
  }
}

/**
 * All refresh paths funnel through here so N concurrent getAccessToken() callers
 * (every IAP connection dialing at once on app resume) share ONE network call
 * instead of stampeding the token endpoint - and, worse, racing each other to
 * write different tokens into SecureStore.
 */
function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight
  const flight = doRefresh().finally(() => {
    if (refreshInFlight === flight) refreshInFlight = null
  })
  refreshInFlight = flight
  return flight
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A valid Google access token with cloud-platform scope, refreshing silently
 * when it is within EXPIRY_SKEW_MS of expiry. Returns null when not signed in
 * or when the refresh token has been rejected.
 */
export async function getAccessToken(): Promise<string | null> {
  await hydrate()
  if (cached && !isStale(cached.expiresAt)) return cached.accessToken
  if (!refreshTokenValue) return null
  return refreshAccessToken()
}

/**
 * Synchronous accessor for callers that cannot await - the connections store's
 * token provider hook runs inside a Zustand action. Returns the cached token
 * while it is still usable and kicks a background refresh when it is stale, so
 * the next dial gets a fresh one.
 */
export function getCachedAccessToken(): string | null {
  const now = Date.now()
  if (cached && !isStale(cached.expiresAt, now)) return cached.accessToken
  void getAccessToken().catch((err) => log.warn('background token refresh failed', err))
  // Still inside its real lifetime, just inside the skew window: usable now.
  return cached && cached.expiresAt > now ? cached.accessToken : null
}

/**
 * Hydrate from SecureStore and refresh if needed. Call once on app start so the
 * first IAP dial has a token without waiting on a round trip.
 */
export async function warmUpGoogleAuth(): Promise<boolean> {
  const token = await getAccessToken()
  if (!token) log.info('no google session on start')
  return token !== null
}

/** The signed-in account's email, or null. Display only - see emailFromIdToken. */
export async function getSignedInEmail(): Promise<string | null> {
  await hydrate()
  return signedInEmail
}

/**
 * Shape of the blob the desktop minting script prints. Parsed leniently so a
 * stray newline or wrapping whitespace from a copy-paste does not fail.
 */
export interface ImportedCredentials {
  clientId: string
  clientSecret?: string
  refreshToken: string
}

/**
 * Parse the pasted credential blob. Accepts the JSON the mint script emits, or
 * a bare refresh token when the client id is already configured in app.json.
 */
export function parseCredentialBlob(raw: string): ImportedCredentials | null {
  const text = raw.trim()
  if (!text) return null
  // The JSON form is the desktop's wire contract, parsed by the shared module
  // that also writes it, so the two cannot drift.
  const fromJson = parseCredentialJson(text)
  if (fromJson) return fromJson
  if (text.startsWith('{')) return null
  // Bare refresh token. Only the phone can complete this shape, because the
  // client id comes from its own app.json rather than from the blob.
  if (!isBareRefreshToken(text)) return null
  const fallback = readClientConfig()
  if (!fallback) return null
  return { clientId: fallback.clientId, clientSecret: fallback.clientSecret, refreshToken: text }
}

/**
 * Adopt credentials minted on the desktop (scripts/google-mint-token.mjs),
 * because Google blocks custom-scheme redirects on Android and the phone cannot
 * run the flow itself. Refreshes once before persisting, so a bad paste fails
 * here rather than at the first tunnel dial.
 */
export async function importCredentials(creds: ImportedCredentials): Promise<string | null> {
  await hydrate()
  const previous = { storedClientId, storedClientSecret, refreshTokenValue }
  storedClientId = creds.clientId
  storedClientSecret = creds.clientSecret ?? null
  refreshTokenValue = creds.refreshToken
  refreshInFlight = null

  try {
    const token = await refreshAccessToken()
    if (!token) throw new Error('Google rejected these credentials.')
  } catch (err) {
    storedClientId = previous.storedClientId
    storedClientSecret = previous.storedClientSecret
    refreshTokenValue = previous.refreshTokenValue
    log.error('credential import failed', err)
    throw err instanceof Error ? err : new Error('Could not import credentials.')
  }

  try {
    await Promise.all([
      SecureStore.setItemAsync(KEY_CLIENT_ID, creds.clientId),
      creds.clientSecret
        ? SecureStore.setItemAsync(KEY_CLIENT_SECRET, creds.clientSecret)
        : SecureStore.deleteItemAsync(KEY_CLIENT_SECRET),
      SecureStore.setItemAsync(KEY_REFRESH_TOKEN, creds.refreshToken),
    ])
  } catch (err) {
    // The refresh already succeeded, so the session works until app exit.
    log.error('persisting imported credentials failed', err)
  }
  log.info('imported google credentials from desktop')
  return signedInEmail
}

/** Revoke at Google (best effort) and wipe local credentials unconditionally. */
export async function signOut(): Promise<void> {
  const token = refreshTokenValue ?? cached?.accessToken
  if (token) {
    try {
      await fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formEncode({ token }),
      })
    } catch (err) {
      // A failed revoke must not block local sign-out.
      log.warn('revoking the token at google failed', err)
    }
  }
  await clearStoredCredentials()
  log.info('signed out')
}
