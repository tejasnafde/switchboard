/**
 * Google sign-in that yields a real cloud-platform access token.
 *
 * Talks to accounts.google.com directly: a broker (Supabase et al) hands back
 * its own session JWT, which cannot call googleapis.com, and the IAP relay needs
 * a Google-issued bearer token.
 *
 * Endpoints are inline rather than fetched from OpenID discovery, to keep a
 * network round trip off the cold-start path. Tokens live in expo-secure-store,
 * never AsyncStorage.
 */
import Constants from 'expo-constants'
import * as AuthSession from 'expo-auth-session'
import * as Linking from 'expo-linking'
import * as SecureStore from 'expo-secure-store'
import * as WebBrowser from 'expo-web-browser'
import { createLogger } from '@shared/logger'

const log = createLogger('google-auth')

// Required once at module scope: on web/Expo Go this settles a pending auth
// session left over from a redirect. Harmless on native, mandatory to call.
WebBrowser.maybeCompleteAuthSession()

/** Google's OAuth 2.0 endpoints (see the module docblock for why these are inline). */
export const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

/**
 * cloud-platform is the scope IAP tunneling actually needs. openid + email are
 * only so the UI can show which account is signed in.
 */
export const SCOPES = ['https://www.googleapis.com/auth/cloud-platform', 'openid', 'email']

/**
 * Google REJECTS an arbitrary custom scheme for installed apps: sending
 * `switchboard://oauth2redirect` fails with "Access blocked: Authorization
 * Error / Error 400: invalid_request" before the consent screen even renders.
 * An Android or iOS client must redirect to the REVERSED client id, i.e.
 * `com.googleusercontent.apps.<id-without-the-suffix>:/oauth2redirect`.
 *
 * Derived from the configured client id rather than hardcoded, so rotating the
 * client cannot leave a stale scheme behind. `app.json` registers the same
 * value in its `scheme` array - that part is native, so changing the client id
 * needs a rebuild, not just an OTA.
 */
const REDIRECT_PATH = 'oauth2redirect'

export function reversedClientScheme(clientId: string): string {
  const bare = clientId.replace(/\.apps\.googleusercontent\.com$/, '')
  return `com.googleusercontent.apps.${bare}`
}

/** Treat a token as stale this long before its real expiry. */
export const EXPIRY_SKEW_MS = 60_000
/**
 * Android closes the Chrome Custom Tab before the deep link is delivered, so
 * openAuthSessionAsync can resolve "dismiss" while the callback is still in
 * flight. Wait this long for the Linking listener before giving up.
 */
const CALLBACK_GRACE_MS = 4_000

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
 * Client id / secret come from Expo config `extra` (app.json). The real values
 * live in Secret Manager secret `switchboard-oauth-client` in GCP project
 * `teejayproject`:
 *
 *   gcloud --configuration=personal secrets versions access latest \
 *     --secret=switchboard-oauth-client
 *
 * app.json ships placeholders and MUST NOT be committed with real values.
 *
 * Client TYPE matters: the Desktop-type client in that secret works for the
 * scripts/iap-probe.mjs loopback flow but will NOT work on device, because
 * Google rejects custom-scheme redirects for Desktop clients. Shipping on
 * Android needs an Android-type client (package name `app.switchboard.mobile`
 * plus the signing SHA-1); iOS needs an iOS-type client, whose redirect is the
 * reversed client id. Neither has a client secret, which is why clientSecret is
 * optional here.
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
  const clientSecret =
    typeof extra.googleClientSecret === 'string' ? extra.googleClientSecret.trim() : ''
  if (!clientId || clientId.startsWith('REPLACE_ME')) {
    log.error('extra.googleClientId is not configured in app.json')
    return null
  }
  return { clientId, clientSecret: clientSecret || undefined }
}

// ---------------------------------------------------------------------------
// Pure helpers (no native modules, no network) - covered by selfCheck() below.
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

/** Google auth codes contain `/` and `-`, so match everything up to a delimiter. */
export function extractAuthCode(url: string): string | null {
  const match = url.match(/[?&]code=([^&#]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export function extractAuthError(url: string): string | null {
  const match = url.match(/[?&]error=([^&#]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export function extractState(url: string): string | null {
  const match = url.match(/[?&]state=([^&#]+)/)
  return match ? decodeURIComponent(match[1]) : null
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
      state.refreshToken
        ? SecureStore.setItemAsync(KEY_REFRESH_TOKEN, state.refreshToken)
        : Promise.resolve(),
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
 * The redirect the OAuth client must have registered. Logged on sign-in because
 * a redirect_uri_mismatch is the single most common first-run failure.
 */
export function getRedirectUri(): string {
  const config = readClientConfig()
  if (!config) return ''
  return AuthSession.makeRedirectUri({
    scheme: reversedClientScheme(config.clientId),
    path: REDIRECT_PATH,
  })
}

/**
 * Open Google's consent screen and exchange the resulting code for tokens.
 * Resolves to the signed-in email, or throws with a message fit for the UI.
 */
export async function signIn(): Promise<string | null> {
  const config = readClientConfig()
  if (!config) {
    throw new Error('Google client id is not configured (app.json extra.googleClientId).')
  }

  const redirectUri = getRedirectUri()
  const request = new AuthSession.AuthRequest({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri,
    scopes: SCOPES,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
    extraParams: {
      // Both are needed for Google to issue a refresh token at all: offline
      // access asks for one, and consent forces the screen even on a repeat
      // sign-in (Google silently omits the refresh token otherwise).
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
  })

  const authUrl = await request.makeAuthUrlAsync({ authorizationEndpoint: AUTHORIZATION_ENDPOINT })
  log.info('starting google sign-in', redirectUri)

  const callbackUrl = await promptForCallback(authUrl, reversedClientScheme(config.clientId))
  if (!callbackUrl) return null // user cancelled

  const error = extractAuthError(callbackUrl)
  if (error) throw new Error(`Google declined the sign-in: ${error}`)

  const returnedState = extractState(callbackUrl)
  if (returnedState && returnedState !== request.state) {
    log.error('state mismatch on the oauth callback')
    throw new Error('Sign-in could not be verified. Please try again.')
  }

  const code = extractAuthCode(callbackUrl)
  if (!code) throw new Error('Google did not return an authorization code.')
  if (!request.codeVerifier) throw new Error('PKCE verifier missing; retry the sign-in.')

  const fields: Record<string, string> = {
    client_id: config.clientId,
    code,
    code_verifier: request.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }
  if (config.clientSecret) fields.client_secret = config.clientSecret

  const body = await postToken(fields)
  if (!body.access_token || typeof body.expires_in !== 'number') {
    throw new Error('Google returned no access token.')
  }
  if (!body.refresh_token) {
    // Not fatal: this session works until the access token expires, then the
    // user has to sign in again. Usually means an earlier grant is being reused.
    log.warn('no refresh_token in the token response; session will not survive expiry')
  }

  const email = body.id_token ? emailFromIdToken(body.id_token) : null
  await persist({
    accessToken: body.access_token,
    expiresAt: expiresAtFrom(body.expires_in),
    refreshToken: body.refresh_token,
    email,
  })
  log.info('signed in', email ?? '(email claim unavailable)')
  return email
}

/** Revoke at Google (best effort) and wipe local credentials unconditionally. */
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
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const clientId = typeof parsed.clientId === 'string' ? parsed.clientId.trim() : ''
      const refreshToken =
        typeof parsed.refreshToken === 'string' ? parsed.refreshToken.trim() : ''
      const clientSecret =
        typeof parsed.clientSecret === 'string' ? parsed.clientSecret.trim() : ''
      if (!clientId || !refreshToken) return null
      return { clientId, refreshToken, clientSecret: clientSecret || undefined }
    } catch {
      // Validator, not an error path: a half-pasted blob is expected, and the
      // screen reports it. Logging would risk echoing credential fragments.
      return null
    }
  }
  // Bare refresh token: Google's look like "1//0g..." - require the prefix so a
  // mis-paste of some other string fails here instead of at the token endpoint.
  if (!text.startsWith('1//')) return null
  const fallback = readClientConfig()
  if (!fallback) return null
  return { clientId: fallback.clientId, clientSecret: fallback.clientSecret, refreshToken: text }
}

/**
 * Adopt credentials minted on the desktop (scripts/google-mint-token.mjs).
 *
 * Why this exists instead of an in-app browser flow: Google no longer permits
 * custom URI scheme redirects on Android, so the app cannot legally complete an
 * authorization-code flow itself. The desktop CAN, over a loopback redirect with
 * the Desktop-type client. So consent happens once on the Mac and the phone
 * inherits the refresh token, after which it renews access tokens on its own
 * forever - no laptop involved again.
 *
 * Validates by performing a real refresh BEFORE persisting, so a bad paste is
 * rejected immediately rather than looking fine until the first tunnel dial.
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

/**
 * Race the two ways the callback can arrive.
 *
 * On iOS, openAuthSessionAsync resolves with the redirect URL. On Android the
 * Custom Tab closes and the URL is delivered through the Linking system
 * instead, so BOTH paths are wired and a handled-codes set makes whichever
 * loses a no-op - the authorization code is single use, and exchanging it twice
 * fails the second time.
 */
const handledCodes = new Set<string>()

function promptForCallback(authUrl: string, callbackScheme: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (url: string | null) => {
      if (settled) return
      settled = true
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
      subscription.remove()
      resolve(url)
    }

    const accept = (url: string) => {
      const code = extractAuthCode(url)
      if (code) {
        if (handledCodes.has(code)) return
        handledCodes.add(code)
      }
      finish(url)
    }

    // callbackScheme is the reversed client id, not the app's own scheme,
    // because that is the only redirect Google accepts for an installed client.
    // app.json registers both.
    const subscription = Linking.addEventListener('url', (event) => {
      if (event.url.startsWith(`${callbackScheme}:`)) accept(event.url)
    })

    // Pass the bare "<scheme>:" rather than the full redirect URI: Android
    // strips the slashes off the return scheme, so the longer form never
    // matches there.
    WebBrowser.openAuthSessionAsync(authUrl, `${callbackScheme}:`)
      .then((result) => {
        if (result.type === 'success') {
          accept(result.url)
          return
        }
        // dismiss / cancel: on Android the Linking listener is probably still
        // in flight, so wait briefly before calling it a cancellation.
        graceTimer = setTimeout(() => {
          log.info('auth session closed with no callback')
          finish(null)
        }, CALLBACK_GRACE_MS)
      })
      .catch((err) => {
        log.error('opening the auth session failed', err)
        finish(null)
      })
  })
}

/**
 * Offline assertion of the refresh-decision logic - no network, no keychain.
 * There is no test runner in apps/mobile yet, so run it from the app when
 * touching this file: add `void selfCheck()` next to the warmUpGoogleAuth()
 * call in App.tsx, reload, and read the console. Returns true when all
 * assertions hold and logs each failure.
 */
export function selfCheck(): boolean {
  const now = 1_700_000_000_000
  const failures: string[] = []
  const expect = (label: string, actual: unknown, wanted: unknown) => {
    if (actual !== wanted) failures.push(`${label}: expected ${String(wanted)}, got ${String(actual)}`)
  }

  expect('expires in 30s is stale', isStale(now + 30_000, now), true)
  expect('expires in 300s is fresh', isStale(now + 300_000, now), false)
  expect('expires exactly at the skew boundary is stale', isStale(now + EXPIRY_SKEW_MS, now), true)
  expect('one ms past the skew boundary is fresh', isStale(now + EXPIRY_SKEW_MS + 1, now), false)
  expect('already expired is stale', isStale(now - 1, now), true)
  expect('expires_in 3600 becomes an absolute deadline', expiresAtFrom(3600, now), now + 3_600_000)

  expect(
    'auth code with slashes survives extraction',
    extractAuthCode('switchboard://oauth2redirect?state=xy&code=4%2F0Ab_c-d&scope=email'),
    '4/0Ab_c-d',
  )
  expect('no code means null', extractAuthCode('switchboard://oauth2redirect?error=access_denied'), null)
  expect(
    'error is extracted',
    extractAuthError('switchboard://oauth2redirect?error=access_denied'),
    'access_denied',
  )
  expect(
    'state is extracted',
    extractState('switchboard://oauth2redirect?code=abc&state=s-1'),
    's-1',
  )

  if (failures.length > 0) {
    for (const failure of failures) log.error(`selfCheck: ${failure}`)
    return false
  }
  log.info('selfCheck: all refresh-decision assertions hold')
  return true
}
