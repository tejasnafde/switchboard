/**
 * The desktop side of the bridge relay connection: the origin rules, the
 * challenge answer, the catalog (no paths), generation fencing, dropped
 * command frames, backoff, and the link that runs the client only while the
 * flag is on and this installation is enrolled.
 */
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigratedDb } from './helpers/test-db'

const logged: unknown[][] = []
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => {
    const record = (...args: unknown[]) => void logged.push(args)
    return { debug: record, info: record, warn: record, error: record }
  },
}))

import { addProject } from '../../src/main/db/database'
import { setBridgeProjectAllowed } from '../../src/main/bridge/allowlist'
import {
  BridgeRelayClient,
  RELAY_SOCKET_OPTIONS,
  backoffMs,
  resolveRelayOrigin,
  type RelaySocketHandlers,
  type Timers,
} from '../../src/main/bridge/relay-client'
import { BridgeDeviceLink, bridgeCatalog, operatorCommand, type DeviceLinkDeps } from '../../src/main/bridge/device-link'
import { defaultDeviceKeyDeps, type DeviceKeyDeps } from '../../src/main/bridge/device-key'
import { bridgeHelloPayload, type BridgeCatalogProject } from '../../src/shared/bridge'

const MACHINE = 'hub-test-machine'
const ORIGIN = 'https://bridge.tn07.dev'

describe('relay origin', () => {
  it('defaults to the bridge host and accepts only https, or loopback http from the env var', () => {
    expect(resolveRelayOrigin({})).toEqual({ ok: true, origin: ORIGIN })
    expect(resolveRelayOrigin({ SB_BRIDGE_RELAY_ORIGIN: 'https://relay.example' })).toEqual({
      ok: true,
      origin: 'https://relay.example',
    })
    for (const origin of ['http://127.0.0.1:8787', 'http://localhost:8787'])
      expect(resolveRelayOrigin({ SB_BRIDGE_RELAY_ORIGIN: origin })).toEqual({ ok: true, origin })
    for (const origin of [
      'http://bridge.tn07.dev',
      'http://127.0.0.1.evil.example',
      'http://10.0.0.5:8787',
      'ws://127.0.0.1:8787',
      'wss://bridge.tn07.dev',
      'https://bridge.tn07.dev/connect',
      'https://bridge.tn07.dev?x=1',
      'https://user:pass@bridge.tn07.dev',
      'file:///tmp/x',
      'not a url',
    ])
      expect(resolveRelayOrigin({ SB_BRIDGE_RELAY_ORIGIN: origin }).ok, origin).toBe(false)
  })

  it('keeps TLS checks on: no option turns certificate validation off', () => {
    expect(RELAY_SOCKET_OPTIONS).not.toHaveProperty('rejectUnauthorized')
    expect(RELAY_SOCKET_OPTIONS.followRedirects).toBe(false)
  })
})

// ─── Client ─────────────────────────────────────────────────────

function fakeTimers() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers & { advance(ms: number): void; delays: number[] } = {
    delays: [],
    now: () => now,
    setTimeout(fn, ms) {
      seq += 1
      pending.set(seq, { at: now + ms, fn })
      timers.delays.push(ms)
      return seq
    },
    clearTimeout: (handle) => void pending.delete(handle as number),
    advance(ms) {
      const until = now + ms
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        pending.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = until
    },
  }
  return timers
}

function harness(catalog: BridgeCatalogProject[] = []) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const sockets: Array<{
    url: string
    headers: Record<string, string>
    on: RelaySocketHandlers
    sent: string[]
    closed: { code: number; reason: string } | null
    terminated: boolean
  }> = []
  const timers = fakeTimers()
  const statuses: string[] = []
  const client = new BridgeRelayClient({
    origin: ORIGIN,
    machineId: MACHINE,
    sign: (text) => sign('sha256', Buffer.from(text), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'),
    catalog: () => catalog,
    userAgent: 'Switchboard/9.9.9',
    timers,
    random: () => 0.5,
    onStatus: (s) => statuses.push(`${s.state}:${s.code ?? ''}`),
    connect: (url, headers, on) => {
      const socket = { url, headers, on, sent: [] as string[], closed: null as null | { code: number; reason: string }, terminated: false }
      sockets.push(socket)
      return {
        send: (text) => void socket.sent.push(text),
        close: (code, reason) => {
          socket.closed = { code, reason }
        },
        terminate: () => {
          socket.terminated = true
        },
      }
    },
  })
  const last = () => sockets[sockets.length - 1]
  const relay = (value: unknown) => last().on.onMessage(JSON.stringify(value))
  const sent = () => last().sent.map((t) => JSON.parse(t) as Record<string, unknown>)
  const nonce = 'N'.repeat(43)
  const connect = (generation = 1) => {
    relay({ type: 'challenge', nonce, wire_version: 1 })
    relay({ type: 'welcome', machine_id: MACHINE, connection_generation: generation, wire_version: 1 })
  }
  return { client, sockets, last, relay, sent, timers, statuses, publicKey, nonce, connect }
}

const PROJECT: BridgeCatalogProject = {
  project_id: 'bproj_1',
  label: 'Website',
  default_agent: null,
  agents: ['claude-code'],
  maximum_mode: 'auto',
}

describe('BridgeRelayClient', () => {
  beforeEach(() => {
    logged.length = 0
  })

  it('dials wss://<relay>/connect with the Switchboard user agent and signs nonce, machine id and origin', () => {
    const h = harness()
    h.client.start()
    expect(h.last().url).toBe('wss://bridge.tn07.dev/connect')
    expect(h.last().headers).toEqual({ 'User-Agent': 'Switchboard/9.9.9' })
    h.relay({ type: 'challenge', nonce: h.nonce, wire_version: 1 })
    const [hello] = h.sent()
    expect(hello).toMatchObject({
      type: 'hello',
      machine_id: MACHINE,
      wire_version: 1,
      capabilities: ['instinct_bridge_v1'],
      relay_origin: ORIGIN,
    })
    const payload = bridgeHelloPayload({ origin: ORIGIN, machineId: MACHINE, nonce: h.nonce })
    expect(payload).toBe(`switchboard-bridge-hello\nv1\n${ORIGIN}\n${MACHINE}\n${h.nonce}`)
    const key = createPublicKey(h.publicKey.export({ format: 'pem', type: 'spki' }))
    expect(
      verify('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(hello.signature), 'base64')),
    ).toBe(true)
  })

  it('sends a catalog with only the public fields after the welcome', () => {
    const leaky = { ...PROJECT, canonical_local_root: '/Users/me/site', path: '/Users/me/site' } as BridgeCatalogProject
    const h = harness([leaky])
    h.client.start()
    h.connect()
    expect(h.client.status()).toEqual({ state: 'connected', code: null, connectionGeneration: 1 })
    const catalog = h.sent()[1]
    expect(catalog).toEqual({ type: 'catalog', projects: [PROJECT] })
    expect(JSON.stringify(catalog)).not.toContain('/Users/')
  })

  it('refuses a challenge of another wire version', () => {
    const h = harness()
    h.client.start()
    h.relay({ type: 'challenge', nonce: h.nonce, wire_version: 2 })
    expect(h.sent()).toEqual([])
    expect(h.last().closed).toEqual({ code: 4000, reason: 'unsupported_version' })
  })

  it('drops frames for another machine or an older generation, and every command frame', () => {
    const h = harness([PROJECT])
    h.client.start()
    h.connect(3)
    const before = h.sent().length
    h.relay({ type: 'command', machine_id: 'hub-other', connection_generation: 3, name: 'start_chat' })
    h.relay({ type: 'command', machine_id: MACHINE, connection_generation: 2, name: 'start_chat' })
    h.relay({ type: 'command', machine_id: MACHINE, connection_generation: 3, name: 'start_chat' })
    h.relay({ type: 'welcome', machine_id: MACHINE, connection_generation: 4, wire_version: 1 })
    expect(h.sent()).toHaveLength(before)
    expect(h.client.status().connectionGeneration).toBe(3)
    const codes = logged.filter((l) => l[0] === 'relay frame dropped').map((l) => (l[1] as { code: string }).code)
    expect(codes).toEqual(['foreign_machine', 'stale_generation', 'commands_disabled', 'stale_generation'])
  })

  it('ignores or refuses a welcome for another machine, and an older generation after a reconnect', () => {
    const h = harness()
    h.client.start()
    h.relay({ type: 'challenge', nonce: h.nonce, wire_version: 1 })
    h.relay({ type: 'welcome', machine_id: 'hub-other', connection_generation: 1, wire_version: 1 })
    expect(h.client.status().state).toBe('connecting')
    h.relay({ type: 'welcome', connection_generation: 1, wire_version: 1 })
    expect(h.last().closed?.reason).toBe('foreign_machine')

    const g = harness()
    g.client.start()
    g.connect(5)
    g.last().on.onClose(1006, '')
    g.timers.advance(60_000)
    expect(g.sockets).toHaveLength(2)
    g.connect(5)
    expect(g.last().closed?.reason).toBe('stale_generation')
    expect(g.client.status().state).not.toBe('connected')
  })

  it('a relay refusal is rejected with its code and retried slowly; a drop is retried soon', () => {
    const h = harness()
    h.client.start()
    h.relay({ type: 'challenge', nonce: h.nonce, wire_version: 1 })
    h.relay({ type: 'error', code: 'revoked' })
    h.last().on.onClose(4003, 'revoked')
    expect(h.client.status()).toEqual({ state: 'rejected', code: 'revoked', connectionGeneration: null })
    expect(h.timers.delays.at(-1)).toBe(30_000)
    h.timers.advance(29_000)
    expect(h.sockets).toHaveLength(1)
    h.timers.advance(1_000)
    expect(h.sockets).toHaveLength(2)

    h.last().on.onClose(1006, '')
    expect(h.client.status()).toEqual({ state: 'retrying', code: 'closed_1006', connectionGeneration: null })
    expect(h.timers.delays.at(-1)).toBe(2_000)
  })

  it('a newer connection elsewhere fences this one: replaced, then retried', () => {
    const h = harness()
    h.client.start()
    h.connect(1)
    h.relay({ type: 'error', code: 'replaced', machine_id: MACHINE, connection_generation: 1 })
    h.last().on.onClose(4005, 'replaced')
    expect(h.client.status().state).toBe('rejected')
    expect(h.client.status().code).toBe('replaced')
  })

  it('closes a socket that is not welcomed in time, and one that goes silent', () => {
    const h = harness()
    h.client.start()
    h.timers.advance(15_000)
    expect(h.last().terminated).toBe(true)

    const g = harness()
    g.client.start()
    g.connect()
    g.timers.advance(30_000)
    expect(g.last().sent.at(-1)).toBe('{"type":"ping"}')
    g.timers.advance(60_000)
    expect(g.last().terminated).toBe(true)
  })

  it('stop closes the socket and nothing redials', () => {
    const h = harness()
    h.client.start()
    h.connect()
    h.client.stop()
    expect(h.last().closed).toEqual({ code: 1000, reason: 'stopped' })
    h.last().on.onClose(1000, 'stopped')
    h.timers.advance(600_000)
    expect(h.sockets).toHaveLength(1)
  })

  it('backs off exponentially with caps', () => {
    const r = () => 0.5
    expect([0, 1, 2, 6, 7, 20].map((n) => backoffMs(n, false, r))).toEqual([1000, 2000, 4000, 60000, 60000, 60000])
    expect([0, 1, 3, 4].map((n) => backoffMs(n, true, r))).toEqual([30000, 60000, 240000, 300000])
  })
})

// ─── Link ───────────────────────────────────────────────────────

const ROOT = mkdtempSync(join(tmpdir(), 'sb-bridge-link-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

function fakeSafeStorage(available: { on: boolean }) {
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a))
  return {
    isEncryptionAvailable: () => available.on,
    encryptString: (text: string) => xor(Buffer.from(text)),
    decryptString: (blob: Buffer) => xor(blob).toString(),
  }
}

function linkHarness(env: NodeJS.ProcessEnv = {}) {
  const flag = { on: true }
  const keychain = { on: true }
  const clients: Array<{ started: number; stopped: number; catalogs: number; origin: string }> = []
  const keys: DeviceKeyDeps = { ...defaultDeviceKeyDeps, safeStorage: () => fakeSafeStorage(keychain) }
  const deps: DeviceLinkDeps = {
    env,
    flagOn: () => flag.on,
    machineId: () => MACHINE,
    keys,
    catalog: () => [],
    userAgent: 'Switchboard/test',
    createClient: (c) => {
      const record = { started: 0, stopped: 0, catalogs: 0, origin: c.origin }
      clients.push(record)
      return {
        start: () => void (record.started += 1),
        stop: () => void (record.stopped += 1),
        sendCatalog: () => void (record.catalogs += 1),
        status: () => ({ state: 'connecting' as const, code: null, connectionGeneration: null }),
      }
    },
  }
  return { link: new BridgeDeviceLink(deps), flag, keychain, clients }
}

describe('BridgeDeviceLink', () => {
  beforeEach(() => {
    createMigratedDb()
  })

  it('runs only while the flag is on and this installation is enrolled', () => {
    const h = linkHarness()
    h.link.reconcile()
    expect(h.clients).toHaveLength(0)
    expect(h.link.status()).toMatchObject({ enabled: true, enrolled: false, state: 'not_enrolled' })

    const status = h.link.enroll('Work Mac')
    expect(h.clients).toHaveLength(1)
    expect(h.clients[0]).toMatchObject({ started: 1, origin: ORIGIN })
    expect(status).toMatchObject({ enrolled: true, machine_id: MACHINE, label: 'Work Mac', state: 'connecting' })
    expect(status.operator_command).toBe(
      `echo '${status.public_key}' | node scripts/bridge-operator.mjs enroll '${MACHINE}' 'Work Mac' -`,
    )

    h.link.reconcile()
    expect(h.clients).toHaveLength(1)
    h.flag.on = false
    h.link.reconcile()
    expect(h.clients[0].stopped).toBe(1)
    expect(h.link.status().state).toBe('off')
    h.flag.on = true
    h.link.reconcile()
    expect(h.clients).toHaveLength(2)
    h.link.catalogChanged()
    expect(h.clients[1].catalogs).toBe(1)

    h.link.removeEnrollment()
    expect(h.clients[1].stopped).toBe(1)
    expect(h.link.status()).toMatchObject({ enrolled: false, state: 'not_enrolled', public_key: null })
    h.link.reconcile()
    expect(h.clients).toHaveLength(2)
  })

  it('refuses to enroll while the flag is off or without a keychain', () => {
    const h = linkHarness()
    h.flag.on = false
    expect(() => h.link.enroll('Work Mac')).toThrow(/off/)
    h.flag.on = true
    h.keychain.on = false
    expect(() => h.link.enroll('Work Mac')).toThrowError(expect.objectContaining({ code: 'encryption_unavailable' }))
    expect(h.link.status().enrolled).toBe(false)
  })

  it('reports an unreadable key and starts nothing', () => {
    const h = linkHarness()
    h.link.enroll('Work Mac')
    h.link.stop()
    h.keychain.on = false
    const fresh = linkHarness()
    fresh.keychain.on = false
    fresh.link.reconcile()
    expect(fresh.clients).toHaveLength(0)
    expect(fresh.link.status()).toMatchObject({ state: 'key_unreadable', code: 'key_unreadable' })
  })

  it('refuses a bad relay origin and names a local one in the operator command', () => {
    const bad = linkHarness({ SB_BRIDGE_RELAY_ORIGIN: 'http://bridge.tn07.dev' })
    bad.link.enroll('Work Mac')
    expect(bad.clients).toHaveLength(0)
    expect(bad.link.status()).toMatchObject({ state: 'key_unreadable', code: 'bad_relay_origin', relay_origin: null })

    expect(
      operatorCommand({ origin: 'http://127.0.0.1:8787', machineId: 'hub-1', label: "Tejas's Mac", publicKey: 'AAAA' }),
    ).toBe(`echo 'AAAA' | BRIDGE_RELAY_ORIGIN='http://127.0.0.1:8787' node scripts/bridge-operator.mjs enroll 'hub-1' 'Tejas'\\''s Mac' -`)
  })
})

describe('bridgeCatalog', () => {
  it('lists the allowed projects with no path', () => {
    createMigratedDb()
    const dir = join(ROOT, 'site')
    mkdirSync(dir, { recursive: true })
    addProject(dir, 'Website')
    setBridgeProjectAllowed(dir, true, MACHINE)
    const catalog = bridgeCatalog(MACHINE)
    expect(catalog).toHaveLength(1)
    expect(Object.keys(catalog[0]).sort()).toEqual(['agents', 'default_agent', 'label', 'maximum_mode', 'project_id'])
    expect(catalog[0]).toMatchObject({ label: 'Website', default_agent: null, maximum_mode: 'auto' })
    expect(JSON.stringify(catalog)).not.toContain(ROOT)
    expect(bridgeCatalog('hub-other')).toEqual([])
  })
})
