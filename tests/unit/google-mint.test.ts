/**
 * Minting a Google refresh token on the desktop, for the phone to inherit.
 *
 * This used to live only in scripts/google-mint-token.mjs, which needs the repo
 * checked out AND a `personal`-configured gcloud with Secret Manager access. So
 * the sign-in screen instructed users to run a command almost none of them can
 * run. The flow moves into the desktop app; these are its decidable parts.
 *
 * Google blocks custom-scheme redirects on Android, which is why consent happens
 * on the desktop at all rather than on the phone.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  AUTH_ENDPOINT,
  GOOGLE_SCOPES,
  buildAuthUrl,
  credentialBlob,
  parseCallback,
  parseCredentialJson,
  resolveClientConfig,
  tokenExchangeBody,
} from '../../src/shared/google-oauth'
import { oauthState, pkceChallenge, pkcePair } from '../../src/main/google/pkce'

const CLIENT_ID = 'cid.apps.googleusercontent.com'
const REDIRECT = 'http://127.0.0.1:8123'

describe('pkceChallenge', () => {
  it('is the url-safe sha256 of the verifier, which is what Google checks', () => {
    const expected = createHash('sha256')
      .update('verifier-abc')
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(pkceChallenge('verifier-abc')).toBe(expected)
  })

  it('never emits base64 padding or the two url-unsafe characters', () => {
    // A '+' or '/' in a query parameter is a silent `invalid_grant` later.
    for (const seed of ['a', 'ab', 'abc', 'abcd']) {
      expect(pkceChallenge(seed)).not.toMatch(/[+/=]/)
    }
  })
})

describe('pkcePair', () => {
  it('produces a challenge that matches its own verifier', () => {
    const pair = pkcePair()
    expect(pair.challenge).toBe(pkceChallenge(pair.verifier))
  })

  it('is fresh per call, so a replayed callback cannot be redeemed', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier)
    expect(oauthState()).not.toBe(oauthState())
  })

  it('emits url-safe material, since both travel in a query string', () => {
    const pair = pkcePair()
    expect(pair.verifier).not.toMatch(/[+/=]/)
    expect(oauthState()).not.toMatch(/[+/=]/)
  })
})

describe('buildAuthUrl', () => {
  const url = new URL(buildAuthUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, state: 'st', challenge: 'ch' }))

  it('asks Google for a refresh token, not just an access token', () => {
    // Without BOTH of these Google returns no refresh_token on a repeat grant,
    // and the phone gets a credential that dies in an hour.
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })

  it('requests the scopes the IAP tunnel actually needs', () => {
    expect(url.searchParams.get('scope')).toBe(GOOGLE_SCOPES.join(' '))
  })

  it('carries the PKCE challenge and the state', () => {
    expect(url.origin + url.pathname).toBe(AUTH_ENDPOINT)
    expect(url.searchParams.get('code_challenge')).toBe('ch')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('response_type')).toBe('code')
  })
})

describe('parseCallback', () => {
  it('accepts the happy path', () => {
    expect(parseCallback('/?code=abc&state=st', 'st')).toEqual({ ok: true, code: 'abc' })
  })

  it('refuses a mismatched state rather than exchanging the code', () => {
    // The whole point of state. Exchanging anyway would let another local
    // process on this machine feed us its own authorization code.
    expect(parseCallback('/?code=abc&state=wrong', 'st').ok).toBe(false)
  })

  it('refuses a missing state, which is the mismatch case that looks empty', () => {
    expect(parseCallback('/?code=abc', 'st').ok).toBe(false)
  })

  it('reports the error Google sent back', () => {
    expect(parseCallback('/?error=access_denied&state=st', 'st')).toEqual({
      ok: false,
      reason: 'access_denied',
    })
  })

  it('refuses a callback with neither a code nor an error', () => {
    expect(parseCallback('/?state=st', 'st')).toEqual({ ok: false, reason: 'no code returned' })
  })

  it('ignores an unrelated request to the loopback server', () => {
    // Browsers ask for /favicon.ico on the callback page, and treating that as
    // a failed sign-in tears the server down before the real callback lands.
    expect(parseCallback('/favicon.ico', 'st')).toEqual({ ok: false, reason: 'ignore' })
  })

  it('ignores a forged error from a page that cannot know the state', () => {
    // Any tab the user has open can hit this port. Without a state check on
    // the error branch, one no-cors fetch kills a sign-in mid-flight.
    expect(parseCallback('/?error=access_denied', 'st')).toEqual({ ok: false, reason: 'ignore' })
    expect(parseCallback('/?error=access_denied&state=wrong', 'st')).toEqual({
      ok: false,
      reason: 'ignore',
    })
  })
})

describe('tokenExchangeBody', () => {
  it('sends the verifier so Google can check the challenge', () => {
    const body = new URLSearchParams(
      tokenExchangeBody({ clientId: CLIENT_ID, code: 'c', verifier: 'v', redirectUri: REDIRECT }),
    )
    expect(body.get('code_verifier')).toBe('v')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe(REDIRECT)
  })

  it('omits the client secret entirely when there is none', () => {
    // An empty client_secret is rejected differently from an absent one.
    const body = new URLSearchParams(
      tokenExchangeBody({ clientId: CLIENT_ID, code: 'c', verifier: 'v', redirectUri: REDIRECT, clientSecret: '' }),
    )
    expect(body.has('client_secret')).toBe(false)
  })

  it('includes the client secret when there is one', () => {
    const body = new URLSearchParams(
      tokenExchangeBody({ clientId: CLIENT_ID, code: 'c', verifier: 'v', redirectUri: REDIRECT, clientSecret: 's' }),
    )
    expect(body.get('client_secret')).toBe('s')
  })
})

describe('credentialBlob round-trip', () => {
  // The desktop writes this and the phone reads it, so the pair IS the wire
  // contract. Both sides call these two functions, which is why asserting the
  // round trip here is enough to pin it.
  it('survives the trip the desktop QR actually makes', () => {
    const blob = credentialBlob({ clientId: CLIENT_ID, clientSecret: 'sec', refreshToken: '1//abc' })
    expect(parseCredentialJson(blob)).toEqual({
      clientId: CLIENT_ID,
      clientSecret: 'sec',
      refreshToken: '1//abc',
    })
  })

  it('round-trips without a client secret', () => {
    const blob = credentialBlob({ clientId: CLIENT_ID, refreshToken: '1//abc' })
    expect(parseCredentialJson(blob)).toEqual({
      clientId: CLIENT_ID,
      clientSecret: undefined,
      refreshToken: '1//abc',
    })
  })

  it('rejects a blob missing the refresh token instead of importing a dud', () => {
    expect(parseCredentialJson(JSON.stringify({ clientId: CLIENT_ID }))).toBeNull()
  })

  it('rejects a truncated paste', () => {
    expect(parseCredentialJson('{"clientId":"x","refresh')).toBeNull()
  })

  it('rejects a bare refresh token, which carries no client id', () => {
    expect(parseCredentialJson('1//abc')).toBeNull()
  })
})

describe('resolveClientConfig', () => {
  const fromEnv = { clientId: 'env-id', clientSecret: 'env-secret' }
  const fromSettings = { clientId: 'set-id', clientSecret: 'set-secret' }

  it('prefers the environment, so a dev can override without touching settings', () => {
    expect(resolveClientConfig({ env: fromEnv, settings: fromSettings })).toEqual(fromEnv)
  })

  it('falls back to what the user saved in settings', () => {
    expect(resolveClientConfig({ env: {}, settings: fromSettings })).toEqual(fromSettings)
  })

  it('returns null when there is no client at all, so the UI can say so', () => {
    expect(resolveClientConfig({ env: {}, settings: {} })).toBeNull()
  })

  it('ignores a half-configured source instead of sending a blank client id', () => {
    // A blank client_id reaches Google as `invalid_client`, which reads like the
    // client was deleted rather than never configured.
    expect(resolveClientConfig({ env: { clientSecret: 'only-secret' }, settings: fromSettings })).toEqual(fromSettings)
  })

  it('allows a client id with no secret, which is a valid installed-app client', () => {
    expect(resolveClientConfig({ env: { clientId: 'env-id' }, settings: {} })).toEqual({
      clientId: 'env-id',
      clientSecret: undefined,
    })
  })
})
