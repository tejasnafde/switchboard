/**
 * Mobile pairing tab - generates the QR a mobile client scans to connect to a
 * headless Switchboard backend (`npm run server`, WsHost). The QR encodes
 * `ws://<host>:<port>?token=<SWITCHBOARD_TOKEN>`; the server refuses to bind
 * beyond loopback without that token, so the tab also shows the exact command
 * to launch the server with it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MobilePairingStatus } from '@shared/types'
import QRCode from 'qrcode'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:mobile-pairing')

const SETTINGS_KEYS = {
  host: 'mobilePairing.host',
  port: 'mobilePairing.port',
  token: 'mobilePairing.token',
} as const

const DEFAULT_PORT = '8765'
const CUSTOM_HOST = '__custom__'

/** Worker `switchboard-apk`: 302s to the newest APK release asset on GitHub. */
const APK_DOWNLOAD_URL = 'https://switchboard.tn07.dev/apk'

interface LanAddress {
  iface: string
  address: string
}

/** 24-char base64url token from 18 random bytes (24 base64 chars, no padding). */
export function generatePairingToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')
}

function isValidPort(raw: string): boolean {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

export function MobilePairingTab() {
  const [lanAddrs, setLanAddrs] = useState<LanAddress[]>([])
  const [host, setHost] = useState('')
  const [port, setPort] = useState(DEFAULT_PORT)
  const [token, setToken] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [customHost, setCustomHost] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [apkQrDataUrl, setApkQrDataUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Whether the desktop is actually serving this QR. Without it a stale QR
  // looks identical to a dead port, which is exactly how it fails in practice.
  const [endpoint, setEndpoint] = useState<MobilePairingStatus | null>(null)

  // Load detected addresses + persisted fields once per mount.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.app.lanAddresses(),
      window.api.settings.get(SETTINGS_KEYS.host),
      window.api.settings.get(SETTINGS_KEYS.port),
      window.api.settings.get(SETTINGS_KEYS.token),
    ]).then(([addrs, savedHost, savedPort, savedToken]) => {
      if (cancelled) return
      setLanAddrs(addrs)
      const initialHost = savedHost ?? addrs[0]?.address ?? ''
      setHost(initialHost)
      setCustomHost(initialHost !== '' && !addrs.some((a) => a.address === initialHost))
      if (savedPort) setPort(savedPort)
      setToken(savedToken ?? generatePairingToken())
      setLoaded(true)
    }).catch((err) => {
      log.warn('failed to load pairing settings', err)
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  // Persist on change (post-load only, so defaults don't clobber saved values),
  // then re-apply the endpoint so the QR is live the moment it renders - no
  // restart. The endpoint reads token/port back from settings, hence the order.
  useEffect(() => {
    if (!loaded) return
    let cancelled = false
    Promise.all([
      window.api.settings.set(SETTINGS_KEYS.host, host),
      window.api.settings.set(SETTINGS_KEYS.port, port),
      window.api.settings.set(SETTINGS_KEYS.token, token),
    ])
      .then(() => window.api.app.mobilePairingApply())
      .then((status) => {
        if (!cancelled) setEndpoint(status)
      })
      .catch((err) => log.warn('failed to persist/apply pairing settings', err))
    return () => { cancelled = true }
  }, [loaded, host, port, token])

  const pairingUrl = useMemo(() => {
    if (!host || !token || !isValidPort(port)) return null
    return `ws://${host}:${port}?token=${token}`
  }, [host, port, token])

  // Regenerate the QR whenever the pairing URL changes.
  useEffect(() => {
    if (!pairingUrl) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    QRCode.toDataURL(pairingUrl, { margin: 1, width: 220 })
      .then((dataUrl) => { if (!cancelled) setQrDataUrl(dataUrl) })
      .catch((err) => {
        log.warn('QR generation failed', err)
        if (!cancelled) setQrDataUrl(null)
      })
    return () => { cancelled = true }
  }, [pairingUrl])

  // The download QR encodes a static URL, so render it once per mount.
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(APK_DOWNLOAD_URL, { margin: 1, width: 160 })
      .then((dataUrl) => { if (!cancelled) setApkQrDataUrl(dataUrl) })
      .catch((err) => log.warn('APK QR generation failed', err))
    return () => { cancelled = true }
  }, [])

  const serverCommand = token
    ? `SWITCHBOARD_TOKEN=${token} HOST=0.0.0.0 npm run server`
    : null

  const copyCommand = useCallback(async () => {
    if (!serverCommand) return
    try {
      await navigator.clipboard.writeText(serverCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      log.warn('clipboard write failed', err)
    }
  }, [serverCommand])

  const onSelectHost = useCallback((value: string) => {
    if (value === CUSTOM_HOST) {
      setCustomHost(true)
      setHost('')
    } else {
      setCustomHost(false)
      setHost(value)
    }
  }, [])

  const selectValue = customHost ? CUSTOM_HOST : host

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    outline: 'none',
  }

  const fieldLabelStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 500,
    color: 'var(--text-secondary)',
    marginBottom: '4px',
  }

  return (
    <div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.6 }}>
        Pair the Switchboard mobile app with a headless backend. Start the server
        with the command below, then scan the QR from the mobile app. The token
        gates every WebSocket connection when the server is reachable beyond
        loopback.
      </div>

      {/* Connection fields */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
        <div style={{ flex: 2, minWidth: 0 }}>
          <div style={fieldLabelStyle}>Host</div>
          <select
            value={selectValue}
            onChange={(e) => onSelectHost(e.target.value)}
            style={{ ...inputStyle, fontFamily: 'inherit', cursor: 'pointer' }}
          >
            {lanAddrs.map((a) => (
              <option key={`${a.iface}-${a.address}`} value={a.address}>
                {a.address} ({a.iface})
              </option>
            ))}
            <option value={CUSTOM_HOST}>Custom hostname…</option>
          </select>
          {customHost && (
            <input
              autoFocus
              value={host}
              onChange={(e) => setHost(e.target.value.trim())}
              placeholder="vm.tailnet-name.ts.net"
              style={{ ...inputStyle, marginTop: '6px' }}
            />
          )}
        </div>
        <div style={{ width: '90px', flexShrink: 0 }}>
          <div style={fieldLabelStyle}>Port</div>
          <input
            value={port}
            onChange={(e) => setPort(e.target.value.trim())}
            placeholder={DEFAULT_PORT}
            style={inputStyle}
          />
        </div>
      </div>

      <div style={{ marginBottom: '14px' }}>
        <div style={fieldLabelStyle}>Token</div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value.trim())}
            placeholder="Click Generate"
            style={inputStyle}
          />
          <button
            onClick={() => setToken(generatePairingToken())}
            style={{
              padding: '6px 12px',
              borderRadius: '4px',
              border: '1px solid var(--border)',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              fontSize: '11.5px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Generate
          </button>
        </div>
      </div>

      {/* QR + pairing URL preview */}
      <div style={{
        display: 'flex',
        gap: '14px',
        alignItems: 'center',
        padding: '12px 14px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-tertiary)',
        marginBottom: '14px',
      }}>
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt="Pairing QR code"
            width={140}
            height={140}
            style={{ borderRadius: '4px', background: '#fff', flexShrink: 0 }}
          />
        ) : (
          <div style={{
            width: '140px',
            height: '140px',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed var(--border)',
            borderRadius: '4px',
            fontSize: '10.5px',
            color: 'var(--text-muted)',
            textAlign: 'center',
            padding: '8px',
          }}>
            {isValidPort(port)
              ? 'Enter a host and token to render the QR'
              : 'Port must be 1-65535'}
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '4px' }}>
            Pairing URL
          </div>
          <div style={{
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-primary)',
            wordBreak: 'break-all',
            lineHeight: 1.5,
          }}>
            {pairingUrl ?? '·'}
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.5 }}>
            Scan from the mobile app. The QR re-renders on every field change.
          </div>
          {endpoint && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginTop: '8px',
              fontSize: '10.5px',
              color: endpoint.listening ? 'var(--text-secondary)' : 'var(--error, #e5544a)',
            }}>
              <span style={{
                width: '6px',
                height: '6px',
                borderRadius: '3px',
                flexShrink: 0,
                background: endpoint.listening ? 'var(--success, #3dd17a)' : 'var(--error, #e5544a)',
              }} />
              {endpoint.listening
                ? `Serving this QR on port ${endpoint.port}`
                : `Not serving: ${endpoint.reason ?? 'unknown'}`}
            </div>
          )}
        </div>
      </div>

      {/* Server command */}
      <div style={fieldLabelStyle}>Run on the target machine</div>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '10px 12px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-primary)',
      }}>
        <code style={{
          flex: 1,
          fontSize: '11px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
          wordBreak: 'break-all',
          lineHeight: 1.6,
        }}>
          {serverCommand ?? 'Generate a token first.'}
        </code>
        <button
          onClick={copyCommand}
          disabled={!serverCommand}
          style={{
            padding: '4px 10px',
            borderRadius: '4px',
            border: '1px solid var(--border)',
            background: 'var(--bg-tertiary)',
            color: copied ? 'var(--success, #3dd17a)' : 'var(--text-primary)',
            fontSize: '11px',
            cursor: serverCommand ? 'pointer' : 'default',
            flexShrink: 0,
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '8px', lineHeight: 1.6 }}>
        You do not need this command for THIS computer: once a token is saved,
        Switchboard itself serves the paired endpoint on the port above after a
        restart, and the phone sees the same chats and sessions as this window.
        The command is for a machine with no Switchboard app running - a VM,
        where the server bundle
        (<code style={{ fontFamily: 'var(--font-mono)' }}>out/server/index.cjs</code>)
        must be present first. The server exits at startup if{' '}
        <code style={{ fontFamily: 'var(--font-mono)' }}>SWITCHBOARD_TOKEN</code>{' '}
        is missing while bound beyond loopback.
      </div>

      {/* APK download QR - static URL, resolved to the newest release by the Worker */}
      <div style={{
        display: 'flex',
        gap: '14px',
        alignItems: 'center',
        padding: '12px 14px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-tertiary)',
        marginTop: '14px',
      }}>
        {apkQrDataUrl && (
          <img
            src={apkQrDataUrl}
            alt="Android app download QR code"
            width={100}
            height={100}
            style={{ borderRadius: '4px', background: '#fff', flexShrink: 0 }}
          />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '4px' }}>
            Get the app
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Scan to download the Android app
          </div>
          <div style={{
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-primary)',
            wordBreak: 'break-all',
            marginTop: '6px',
          }}>
            {APK_DOWNLOAD_URL}
          </div>
        </div>
      </div>
    </div>
  )
}
