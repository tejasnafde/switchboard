#!/usr/bin/env node
// Operator commands for the Instinct bridge relay's device list and stop controls.
//
//   node scripts/bridge-operator.mjs enroll <machine_id> <label> <public_key_file|->
//   node scripts/bridge-operator.mjs revoke <machine_id>
//   node scripts/bridge-operator.mjs list
//   node scripts/bridge-operator.mjs stop-status            stop generation, kill and each machine's stop state
//   node scripts/bridge-operator.mjs kill                   stop bridge work on every machine and refuse new work
//   node scripts/bridge-operator.mjs clear-kill             allow new bridge work again (the generation stays)
//   node scripts/bridge-operator.mjs revoke-assistant-key   disable the assistant key and stop bridge work
//
// The operator key comes from BRIDGE_OPERATOR_KEY, else Secret Manager
// `switchboard-bridge-operator-key` (project teejayproject, gcloud
// configuration `personal`). It is sent only in the Authorization header and
// never printed. BRIDGE_RELAY_ORIGIN picks another relay (default
// https://bridge.tn07.dev); plain http is allowed only for 127.0.0.1,
// localhost and [::1].
//
// The public key file holds what Settings > Labs shows: SPKI base64, a PEM
// public key, or a public JWK. `-` reads it from stdin.

import { execFileSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const USER_AGENT = 'Switchboard-operator/1'
const DEFAULT_ORIGIN = 'https://bridge.tn07.dev'
const GCLOUD = process.env.GCLOUD ?? 'gcloud'

function fail(message) {
  console.error(`bridge-operator: ${message}`)
  process.exit(1)
}

function relayOrigin() {
  const raw = process.env.BRIDGE_RELAY_ORIGIN?.trim() || DEFAULT_ORIGIN
  let url
  try {
    url = new URL(raw)
  } catch {
    fail('BRIDGE_RELAY_ORIGIN is not a URL.')
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    fail('The relay origin must use https (http only for 127.0.0.1, localhost or [::1]).')
  return url.origin
}

function operatorKey() {
  const fromEnv = process.env.BRIDGE_OPERATOR_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const key = execFileSync(
      GCLOUD,
      [
        '--configuration=personal',
        'secrets',
        'versions',
        'access',
        'latest',
        '--secret=switchboard-bridge-operator-key',
        '--project=teejayproject',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    if (!key) fail('The operator key secret is empty.')
    return key
  } catch (err) {
    // stderr can name the account and project, never the key; the key is only on stdout.
    fail(
      `Could not read the operator key from Secret Manager (${err.status ?? err.code ?? 'error'}). Set BRIDGE_OPERATOR_KEY or sign in to gcloud.`,
    )
  }
}

/** SPKI base64, PEM or JWK text as the relay's public_key value. */
export function parsePublicKey(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    const jwk = JSON.parse(trimmed)
    if (jwk.d !== undefined) throw new Error('That JWK holds a private key. Send only the public key.')
    return jwk
  }
  if (/PRIVATE KEY/.test(trimmed)) throw new Error('That file holds a private key. Send only the public key.')
  const pem = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/.exec(trimmed)
  const base64 = (pem ? pem[1] : trimmed).replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('The public key is not base64, PEM or a JWK.')
  try {
    createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' })
  } catch {
    // A PKCS#8 private key in bare base64 lands here too: it is never sent.
    throw new Error('The key is not an SPKI public key. Send only the public key Settings shows.')
  }
  return base64
}

async function request(method, path, body) {
  const response = await fetch(`${relayOrigin()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${operatorKey()}`,
      'user-agent': USER_AGENT,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { status: response.status }
  }
  if (!response.ok) fail(`${response.status} ${parsed.code ?? ''} ${parsed.message ?? ''}`.trim())
  return parsed
}

/** The stop commands take no arguments: the relay keeps one stop state for all machines. */
const STOP_COMMANDS = {
  'stop-status': ['GET', '/operator/stop'],
  kill: ['POST', '/operator/stop'],
  'clear-kill': ['DELETE', '/operator/stop'],
  'revoke-assistant-key': ['POST', '/operator/assistant-key/revoke'],
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'enroll') {
    const [machineId, label, file] = args
    if (!machineId || !label || !file) fail('usage: enroll <machine_id> <label> <public_key_file|->')
    let publicKey
    try {
      publicKey = parsePublicKey(readFileSync(file === '-' ? 0 : file, 'utf8'))
    } catch (err) {
      fail(err.message)
    }
    const result = await request('POST', '/operator/devices', { machine_id: machineId, label, public_key: publicKey })
    console.log(JSON.stringify(result, null, 2))
  } else if (command === 'revoke') {
    const [machineId] = args
    if (!machineId) fail('usage: revoke <machine_id>')
    const result = await request('DELETE', `/operator/devices/${encodeURIComponent(machineId)}`)
    console.log(JSON.stringify(result, null, 2))
  } else if (command === 'list') {
    console.log(JSON.stringify(await request('GET', '/operator/devices'), null, 2))
  } else if (Object.hasOwn(STOP_COMMANDS, command ?? '')) {
    const [method, path] = STOP_COMMANDS[command]
    console.log(JSON.stringify(await request(method, path), null, 2))
  } else {
    fail(
      'usage: enroll <machine_id> <label> <public_key_file|-> | revoke <machine_id> | list | stop-status | kill | clear-kill | revoke-assistant-key',
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
