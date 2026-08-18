import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IapFrameParser, encodeIapData } from '../../src/shared/iap-tunnel'
import { decodeFrame, encodeFrame, type WsFrame } from '../../src/shared/ws-protocol'

const FIXTURE_ROOT = resolve('tests/fixtures/mobile-native')

function fixture<T>(relativePath: string): T {
  const path = resolve(FIXTURE_ROOT, relativePath)
  expect(existsSync(path), `missing compatibility fixture: ${relativePath}`).toBe(true)
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

interface ZustandWrapper<T> {
  state: T
  version: number
}

interface TableDump {
  database: string
  table: string
  columns: ['key', 'value']
  rows: Array<{ key: string; value: string }>
}

interface ProtocolGolden {
  name: string
  wire: string
  expected: WsFrame
}

function hexBytes(hex: string): Uint8Array {
  expect(hex).toMatch(/^(?:[0-9a-f]{2})*$/)
  return Uint8Array.from(hex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [])
}

function bytesHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('native migration goldens', () => {
  it('captures both legacy AsyncStorage SQLite table layouts with identical logical records', () => {
    const rk = fixture<TableDump>('async-storage/rkstorage.json')
    const next = fixture<TableDump>('async-storage/asyncstorage.json')

    expect(rk).toMatchObject({
      database: 'RKStorage',
      table: 'catalystLocalStorage',
      columns: ['key', 'value'],
    })
    expect(next).toMatchObject({
      database: 'AsyncStorage',
      table: 'Storage',
      columns: ['key', 'value'],
    })
    expect(next.rows).toEqual(rk.rows)
    expect(rk.rows.map((row) => row.key)).toEqual([
      'sb-chat-cache',
      'sb-connections',
      'sb-outbox:turn-image-only',
      'sb-outbox:turn-text',
      'switchboard-prefs',
    ])
  })

  it('keeps the exact Zustand connection, preference and chat wrappers stored in the table dumps', () => {
    const dump = fixture<TableDump>('async-storage/rkstorage.json')
    const wrappers = {
      'sb-connections': fixture<ZustandWrapper<Record<string, unknown>>>('zustand/connections.json'),
      'switchboard-prefs': fixture<ZustandWrapper<Record<string, unknown>>>('zustand/prefs.json'),
      'sb-chat-cache': fixture<ZustandWrapper<Record<string, unknown>>>('zustand/chat-cache.json'),
    }

    for (const [key, expected] of Object.entries(wrappers)) {
      const row = dump.rows.find((candidate) => candidate.key === key)
      expect(row, `missing ${key} from RKStorage dump`).toBeDefined()
      expect(JSON.parse(row!.value)).toEqual(expected)
      expect(expected.version).toBe(0)
    }

    const connections = wrappers['sb-connections'].state.configs as Array<Record<string, unknown>>
    expect(connections.map((connection) => connection.kind)).toEqual(['ws', 'ws', 'iap'])
    expect(connections.find((connection) => connection.id === 'legacy-lan')).toMatchObject({
      token: 'fixture-legacy-shared-token',
    })

    const threads = wrappers['sb-chat-cache'].state.threads as Record<string, unknown>
    expect(Object.keys(threads)).toEqual(['lan-main:thread-same', 'work-iap:thread-same'])
  })

  it('preserves raw text and image-only outbox records byte-for-byte in each database dump', () => {
    const dump = fixture<TableDump>('async-storage/rkstorage.json')
    const text = fixture<Record<string, unknown>>('outbox/turn-text.json')
    const imageOnly = fixture<Record<string, unknown>>('outbox/turn-image-only.json')

    expect(text).toMatchObject({
      connectionId: 'lan-main',
      threadId: 'thread-same',
      messageId: 'turn-text',
      runtimeMode: 'sandbox',
      attempts: 2,
    })
    expect(imageOnly).toMatchObject({
      connectionId: 'work-iap',
      threadId: 'thread-same',
      messageId: 'turn-image-only',
      text: '',
      attempts: 0,
    })
    expect(imageOnly.images).toEqual([
      { url: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' },
    ])

    for (const record of [text, imageOnly]) {
      const key = `sb-outbox:${record.messageId as string}`
      expect(dump.rows.find((row) => row.key === key)?.value).toBe(JSON.stringify(record))
    }
  })

  it('pins Expo SecureStore logical keys and connection safeId normalization', () => {
    const keys = fixture<{
      sharedPreferences: string
      defaultKeychainService: string
      connections: Array<{
        connectionId: string
        safeId: string
        tokenKey: string
        sessionKey: string
        tokenPreferenceKey: string
        sessionPreferenceKey: string
      }>
      googleKeys: string[]
    }>('secure-store/keys.json')

    expect(keys.sharedPreferences).toBe('SecureStore')
    expect(keys.defaultKeychainService).toBe('key_v1')
    for (const entry of keys.connections) {
      const safeId = entry.connectionId.replace(/[^A-Za-z0-9._-]/g, '_')
      expect(entry.safeId).toBe(safeId)
      expect(entry.tokenKey).toBe(`sb-token-${safeId}`)
      expect(entry.sessionKey).toBe(`sb-session-${safeId}`)
      expect(entry.tokenPreferenceKey).toBe(`key_v1-${entry.tokenKey}`)
      expect(entry.sessionPreferenceKey).toBe(`key_v1-${entry.sessionKey}`)
    }
    expect(keys.googleKeys).toEqual([
      'sb.google.refresh_token',
      'sb.google.access_token',
      'sb.google.expires_at',
      'sb.google.email',
      'sb.google.client_id',
      'sb.google.client_secret',
    ])
  })
})

describe('native protocol goldens', () => {
  it('round-trips auth, resume, RPC and replay-gap frames through the shared codec', () => {
    const goldens = fixture<ProtocolGolden[]>('protocol/ws-frames.json')
    expect(goldens.map((golden) => golden.name)).toEqual([
      'auth-pairing',
      'auth-session',
      'hello-resume',
      'ready-resumed',
      'request-send-turn',
      'response-success',
      'response-failure',
      'send-viewing',
      'event-content',
      'ready-replay-gap',
    ])

    for (const golden of goldens) {
      expect(decodeFrame(golden.wire), golden.name).toEqual(golden.expected)
      expect(encodeFrame(golden.expected), golden.name).toBe(golden.wire)
    }
    expect(goldens.at(-1)?.expected).toMatchObject({ k: 'ready', gap: true, replayed: 0 })
  })

  it('reassembles IAP DATA payloads whose boundaries split multibyte UTF-8 characters', () => {
    const golden = fixture<{
      text: string
      payloadChunksHex: string[]
      iapFramesHex: string[]
      expected: WsFrame
    }>('protocol/iap-split-utf8.json')

    const payloadChunks = golden.payloadChunksHex.map(hexBytes)
    expect(payloadChunks.map((chunk) => bytesHex(encodeIapData(chunk)))).toEqual(golden.iapFramesHex)

    const parser = new IapFrameParser()
    const payloads = golden.iapFramesHex.flatMap((hex) => parser.push(hexBytes(hex)))
      .filter((frame): frame is { kind: 'data'; payload: Uint8Array } => frame.kind === 'data')
      .map((frame) => frame.payload)
    const joined = new Uint8Array(payloads.reduce((size, payload) => size + payload.length, 0))
    let offset = 0
    for (const payload of payloads) {
      joined.set(payload, offset)
      offset += payload.length
    }

    expect(new TextDecoder().decode(joined)).toBe(golden.text)
    expect(decodeFrame(golden.text.trimEnd())).toEqual(golden.expected)
    expect(payloadChunks.some((chunk) => new TextDecoder().decode(chunk).includes('\ufffd'))).toBe(true)
  })
})
