/**
 * Mobile pairing.
 *
 * The QR encodes `ws://<host>:<port>?pair=<code>`, where the code is one-time
 * and expires in five minutes. A phone redeems it once for a session of its
 * own, which can be revoked without disturbing any other device.
 *
 * The old shared token is still stored and still accepted, because a phone
 * paired before this existed holds it and clearing it would lock that phone
 * out with no way back. It has no part in the flow above and is retired per
 * device as each one re-pairs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MobilePairingStatus } from '@shared/types'
import type { DeviceSessionView } from '@shared/device-auth'
import QRCode from 'qrcode'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:mobile-pairing')

const SETTINGS_KEYS = {
  host: 'mobilePairing.host',
  port: 'mobilePairing.port',
  token: 'mobilePairing.token',
  enabled: 'mobilePairing.enabled',
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

/**
 * Compact "?" that carries a long explanation in a native tooltip. The panel
 * had grown four paragraphs of prose nobody reads twice; the detail is still
 * one hover away.
 */
function InfoHint({ text }: { text: string }) {
  return (
    <span
      title={text}
      aria-label={text}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '13px',
        height: '13px',
        marginLeft: '5px',
        borderRadius: '50%',
        border: '1px solid var(--border)',
        color: 'var(--text-muted)',
        fontSize: '9px',
        lineHeight: 1,
        cursor: 'help',
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
    >
      ?
    </span>
  )
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
  /** Live pairing code. Minted on demand, never persisted in this component. */
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [devices, setDevices] = useState<DeviceSessionView[]>([])
  /** The endpoint listens only while this is on. Opening a port is a decision
   *  the user makes, not a side effect of looking at the tab. */
  const [enabled, setEnabled] = useState(false)
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
      window.api.settings.get(SETTINGS_KEYS.enabled),
    ]).then(([addrs, savedHost, savedPort, savedToken, savedEnabled]) => {
      if (cancelled) return
      setLanAddrs(addrs)
      const initialHost = savedHost ?? addrs[0]?.address ?? ''
      setHost(initialHost)
      setCustomHost(initialHost !== '' && !addrs.some((a) => a.address === initialHost))
      if (savedPort) setPort(savedPort)
      // Do NOT mint a token here. Generating one on mount and persisting it
      // below meant merely LOOKING at this tab opened a LAN listener with a
      // static credential, on every future launch, with no way to turn it off.
      setToken(savedToken ?? '')
      setEnabled(savedEnabled === 'true')
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
      window.api.settings.set(SETTINGS_KEYS.enabled, enabled ? 'true' : 'false'),
    ])
      .then(() => window.api.app.mobilePairingApply())
      .then((status) => {
        if (!cancelled) setEndpoint(status)
      })
      .catch((err) => log.warn('failed to persist/apply pairing settings', err))
    return () => { cancelled = true }
  }, [loaded, host, port, token, enabled])

  const refreshDevices = useCallback(() => {
    window.api.app
      .mobileDevices()
      .then(setDevices)
      .catch((err: unknown) => log.warn('failed to list paired devices', err))
  }, [])

  useEffect(() => {
    if (loaded) refreshDevices()
  }, [loaded, refreshDevices])

  /** Mint a fresh code. Any previous unused one stops working immediately. */
  const startPairing = useCallback(() => {
    window.api.app
      .mobilePairingCode()
      .then((code) => setPairing({ code: code.code, expiresAt: code.expiresAt }))
      .catch((err: unknown) => log.warn('failed to mint a pairing code', err))
  }, [])

  // Count down, and drop the QR the moment it stops working. Showing an expired
  // code is worse than showing none: the scan fails with nothing on screen
  // explaining why.
  useEffect(() => {
    if (!pairing) {
      setSecondsLeft(0)
      return
    }
    const tick = (): void => {
      const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left === 0) setPairing(null)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [pairing])

  // A redeemed code is consumed server-side, so the device list is the only
  // signal that a scan worked. Poll while a code is live.
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(refreshDevices, 2000)
    return () => clearInterval(timer)
  }, [pairing, refreshDevices])

  const revoke = useCallback(
    (id: string) => {
      window.api.app
        .mobileRevokeDevice(id)
        .then(refreshDevices)
        .catch((err: unknown) => log.warn('failed to revoke a device', err))
    },
    [refreshDevices],
  )

  const pairingUrl = useMemo(() => {
    if (!host || !pairing || !isValidPort(port)) return null
    return `ws://${host}:${port}?pair=${pairing.code}`
  }, [host, port, pairing])

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

  // HOST serves the `ws` kind, TCP_PORT the `iap` one. Both, so neither silently fails.
  const serverCommand = token
    ? `SWITCHBOARD_TOKEN=${token} HOST=0.0.0.0 TCP_PORT=8766 npm run server`
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
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '12px',
          color: 'var(--text-primary)',
          marginBottom: '10px',
          cursor: 'pointer',
        }}
      >
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Serve the mobile endpoint
        <InfoHint text="Opens a listener on the port below, reachable from your local network, so a paired phone sees the same chats and sessions as this window. Off by default: nothing listens until you turn it on, and turning it off stops it immediately. Paired devices keep their credentials and reconnect when it is on again." />
      </label>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.6 }}>
        {enabled
          ? 'Scan the QR below from the mobile app to pair it with this computer.'
          : 'The endpoint is off. Nothing is listening.'}
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
            {!enabled
              ? 'Turn the endpoint on to pair'
              : !isValidPort(port)
                ? 'Port must be 1-65535'
                : !host
                  ? 'Pick an address to render the QR'
                  : 'Tap Show pairing QR'}
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-secondary)' }}>
              Pairing URL
            </div>
            <button
              onClick={startPairing}
              disabled={!enabled || !host || !isValidPort(port)}
              style={{
                fontSize: '10.5px',
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text-secondary)',
                cursor: host && isValidPort(port) ? 'pointer' : 'default',
              }}
            >
              {pairing ? 'New code' : 'Show pairing QR'}
            </button>
            {pairing && (
              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                expires in {secondsLeft}s
              </span>
            )}
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

      {/* Paired devices */}
      <div style={fieldLabelStyle}>
        Paired devices
        <InfoHint text="Each device holds a credential of its own. Revoking one cuts it off immediately and leaves every other device working. A device paired before this change still uses the old shared token and shows as legacy until it scans a new code." />
      </div>
      {devices.length === 0 ? (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px' }}>
          Nothing paired yet. Show the QR above and scan it from the phone.
        </div>
      ) : (
        <div style={{ marginBottom: '14px' }}>
          {devices.map((device) => (
            <div
              key={device.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 0',
                borderBottom: '1px solid var(--border)',
                opacity: device.revoked ? 0.5 : 1,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '11.5px', color: 'var(--text-primary)' }}>{device.label}</div>
                <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                  {device.revoked ? 'revoked' : `last seen ${new Date(device.lastSeenAt).toLocaleString()}`}
                  {' · '}
                  {device.scopes.join(', ')}
                </div>
              </div>
              {!device.revoked && (
                <button
                  onClick={() => revoke(device.id)}
                  style={{
                    fontSize: '10.5px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    border: '1px solid var(--border)',
                    background: 'transparent',
                    color: 'var(--error, #e5544a)',
                    cursor: 'pointer',
                  }}
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}

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
        Only for a machine with no Switchboard app running, such as a VM. Runs in the
        foreground, so start it under tmux, and pair from the QR it prints.
        <InfoHint text="This computer needs no command: it serves the endpoint itself. On a VM, the server bundle (out/server/index.cjs) must be present first, and binding beyond loopback without SWITCHBOARD_TOKEN mints one and saves it to ~/.switchboard-server/token. TCP_PORT starts a second listener on 8766 speaking ndjson, which is what an IAP-tunnelled phone dials. Running it here as well would take the port and stop the app from serving." />
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
