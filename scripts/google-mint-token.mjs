/**
 * Mint a Google refresh token on the desktop for the mobile app to inherit.
 *
 * Why: Google no longer permits custom URI scheme redirects on Android
 * (developers.google.com/identity/protocols/oauth2/native-app), so the phone
 * cannot legally complete an authorization-code flow itself. The desktop CAN,
 * over a loopback redirect with the Desktop-type client - the same flow that
 * scripts/iap-probe.mjs was validated against. So consent happens here once and
 * the phone inherits the refresh token, after which it renews access tokens by
 * itself with no laptop involved.
 *
 * Usage (client id/secret come from Secret Manager by default):
 *   node scripts/google-mint-token.mjs
 *   node scripts/google-mint-token.mjs --client-id ... --client-secret ...
 *
 * Prints a JSON blob to paste into the phone: Account -> Import from desktop.
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform', 'openid', 'email']
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SECRET_NAME = 'switchboard-oauth-client'
const PORT = 8123

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Read the Desktop OAuth client out of Secret Manager (personal config). */
function clientFromSecretManager() {
  const gcloud = `${process.env.HOME}/Downloads/google-cloud-sdk/bin/gcloud`
  const out = execFileSync(
    gcloud,
    [
      '--configuration=personal',
      'secrets',
      'versions',
      'access',
      'latest',
      `--secret=${SECRET_NAME}`,
    ],
    { encoding: 'utf8', env: { ...process.env, CLOUDSDK_PYTHON: `${process.env.HOME}/.config/gcloud/virtenv/bin/python3` } },
  )
  const parsed = JSON.parse(out)
  return { clientId: parsed.client_id, clientSecret: parsed.client_secret }
}

const clientId = arg('client-id') ?? clientFromSecretManager().clientId
const clientSecret = arg('client-secret') ?? clientFromSecretManager().clientSecret
if (!clientId) {
  console.error('no client id: pass --client-id or store one in Secret Manager')
  process.exit(2)
}

const verifier = b64url(randomBytes(32))
const challenge = b64url(createHash('sha256').update(verifier).digest())
const state = b64url(randomBytes(16))
const redirectUri = `http://127.0.0.1:${PORT}`

const authUrl =
  `${AUTH_ENDPOINT}?` +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })

console.log('\nOpen this URL and consent as the account that reaches your VMs:\n')
console.log(authUrl + '\n')
try {
  execFileSync('open', [authUrl])
} catch {
  console.log('(could not open a browser automatically, paste the URL yourself)')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri)
  const code = url.searchParams.get('code')
  const err = url.searchParams.get('error')
  const returnedState = url.searchParams.get('state')

  if (err || !code) {
    res.end(`Sign-in failed: ${err ?? 'no code returned'}`)
    console.error(`\nfailed: ${err ?? 'no code returned'}`)
    server.close()
    process.exit(1)
  }
  if (returnedState !== state) {
    res.end('State mismatch, aborting.')
    console.error('\nstate mismatch - possible interference, aborting')
    server.close()
    process.exit(1)
  }

  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  })
  if (clientSecret) body.set('client_secret', clientSecret)

  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const tokens = await tokenRes.json()

  if (!tokenRes.ok || !tokens.refresh_token) {
    res.end('Token exchange failed, see the terminal.')
    console.error('\ntoken exchange failed:', tokens.error_description ?? tokens.error ?? tokens)
    if (tokenRes.ok && !tokens.refresh_token) {
      console.error('no refresh_token returned - revoke prior access at')
      console.error('https://myaccount.google.com/permissions and retry, or the')
      console.error('grant already exists and Google withheld a new one.')
    }
    server.close()
    process.exit(1)
  }

  res.end('Done. Return to the terminal, then paste the blob into the phone.')
  const blob = { clientId, clientSecret, refreshToken: tokens.refresh_token }
  console.log('\nPaste this into the phone (Account -> Import from desktop):\n')
  console.log(JSON.stringify(blob))
  console.log('\nTreat it like a password: it grants cloud-platform access as you.')
  server.close()
  process.exit(0)
})

server.listen(PORT, '127.0.0.1', () => console.log(`waiting for the callback on ${redirectUri} ...`))
