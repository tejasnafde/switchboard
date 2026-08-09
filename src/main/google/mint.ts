/**
 * Run Google's authorization-code flow here and hand the phone the refresh
 * token. In the app, not just scripts/google-mint-token.mjs, because that
 * script needs the repo plus a `personal` gcloud that no released build has.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { shell } from 'electron'
import {
  LOOPBACK_PORT,
  LOOPBACK_REDIRECT,
  TOKEN_ENDPOINT,
  buildAuthUrl,
  credentialBlob,
  parseCallback,
  tokenExchangeBody,
  type ClientConfig,
} from '@shared/google-oauth'
import { createMainLogger } from '../logger'
import { oauthState, pkcePair } from './pkce'

const log = createMainLogger('google:mint')

/** Long enough to pick an account, short enough not to hold the port. */
const CONSENT_TIMEOUT_MS = 5 * 60_000

export interface MintResult {
  /** The QR/paste payload, already in the shape the phone parses. */
  blob: string
}

interface TokenResponse {
  refresh_token?: string
  error?: string
  error_description?: string
}

/** Typed and never reflecting the query back: a sniffed body would run as HTML
 *  on a loopback origin that can reach code-server (`--auth none`). */
function respond(res: ServerResponse, body: string): void {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  // `close()` only stops new connections; without this the keep-alive socket
  // holds 8123 and the next attempt hits EADDRINUSE against ourselves.
  res.setHeader('Connection', 'close')
  res.end(body)
}

/** Single-flight: the redirect URI pins port 8123, so an abandoned consent tab
 *  would hold it for the full timeout and the retry would blame a stranger. */
let inFlight: { promise: Promise<MintResult>; cancel: () => void } | null = null

/** Abandon a mint in progress and free the port. Safe when nothing is running. */
export function cancelGoogleMint(): void {
  inFlight?.cancel()
}

/** Rejects rather than resolving a partial result: a credential with no
 *  refresh token imports fine and dies an hour later, far from the cause. */
export async function mintGoogleCredentials(client: ClientConfig): Promise<MintResult> {
  // A second click means "I want to start over", not "fail because I clicked".
  cancelGoogleMint()
  const run = startMint(client)
  inFlight = run
  try {
    return await run.promise
  } finally {
    if (inFlight === run) inFlight = null
  }
}

function startMint(client: ClientConfig): { promise: Promise<MintResult>; cancel: () => void } {
  const { verifier, challenge } = pkcePair()
  const state = oauthState()
  const authUrl = buildAuthUrl({
    clientId: client.clientId,
    redirectUri: LOOPBACK_REDIRECT,
    state,
    challenge,
  })

  let cancel = (): void => {}
  const promise = new Promise<MintResult>((resolve, reject) => {
    let server: Server | undefined
    let timer: NodeJS.Timeout | undefined
    let settled = false

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // Keep-alive sockets too, or the port stays bound.
      server?.closeAllConnections?.()
      server?.close()
      fn()
    }
    cancel = () => settle(() => reject(new Error('Google sign-in was cancelled.')))

    server = createServer((req, res) => {
      const outcome = parseCallback(req.url ?? '/', state)
      if (!outcome.ok) {
        // A favicon fetch or a forged error must not close the server.
        if (outcome.reason === 'ignore') {
          res.statusCode = 404
          respond(res, 'not found')
          return
        }
        // Not echoed - it can carry a query value from any page.
        respond(res, 'Sign-in failed. Return to Switchboard for the reason.')
        settle(() => reject(new Error(outcome.reason)))
        return
      }

      void (async () => {
        try {
          const tokenRes = await fetch(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenExchangeBody({
              clientId: client.clientId,
              clientSecret: client.clientSecret,
              code: outcome.code,
              verifier,
              redirectUri: LOOPBACK_REDIRECT,
            }),
          })
          const tokens = (await tokenRes.json()) as TokenResponse

          if (!tokenRes.ok) {
            throw new Error(tokens.error_description ?? tokens.error ?? `HTTP ${tokenRes.status}`)
          }
          if (!tokens.refresh_token) {
            // Withheld when an unrevoked grant already exists, even with
            // prompt=consent.
            throw new Error(
              'Google returned no refresh token. Revoke the previous grant at ' +
                'myaccount.google.com/permissions, then try again.',
            )
          }

          respond(res, 'Done. Return to Switchboard and scan the QR with your phone.')
          settle(() =>
            resolve({
              blob: credentialBlob({
                clientId: client.clientId,
                clientSecret: client.clientSecret,
                refreshToken: tokens.refresh_token as string,
              }),
            }),
          )
        } catch (err) {
          respond(res, 'Token exchange failed. Return to Switchboard for the reason.')
          settle(() => reject(err instanceof Error ? err : new Error(String(err))))
        }
      })()
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      // The port is pinned by the registered redirect URI.
      const message =
        err.code === 'EADDRINUSE'
          ? `Port ${LOOPBACK_PORT} is busy, so the sign-in callback cannot be received. Close whatever is using it and retry.`
          : err.message
      settle(() => reject(new Error(message)))
    })

    server.listen(LOOPBACK_PORT, '127.0.0.1', () => {
      log.info('waiting for the google callback', { redirect: LOOPBACK_REDIRECT })
      void shell.openExternal(authUrl).catch((err: unknown) => {
        log.warn('could not open a browser for consent', err)
      })
    })

    timer = setTimeout(() => {
      settle(() => reject(new Error('Timed out waiting for Google sign-in.')))
    }, CONSENT_TIMEOUT_MS)
  })
  return { promise, cancel: () => cancel() }
}
