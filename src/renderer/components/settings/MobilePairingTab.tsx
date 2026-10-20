/**
 * Mobile pairing.
 *
 * The QR encodes `ws://<host>:<port>?pair=<code>&fp=<sha256>`, where the code is
 * one-time and expires in five minutes, and `fp` pins the endpoint's TLS
 * certificate: a phone that knows it dials wss:// on the same port, an older
 * one ignores it and keeps ws://. A phone redeems it once for a session of its
 * own, which can be revoked without disturbing any other device.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MobilePairingStatus } from '@shared/types'
import { shortFingerprint } from '@shared/connection-security'
import { withCertPin } from '@shared/transport-security'
import type { DeviceSessionView } from '@shared/device-auth'
import QRCode from 'qrcode'
import { GoogleMintPanel } from './GoogleMintPanel'
import { PairedDevices } from './PairedDevices'
import { Combobox } from '../ui/combobox'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:mobile-pairing')

const SETTINGS_KEYS = {
  host: 'mobilePairing.host',
  port: 'mobilePairing.port',
  enabled: 'mobilePairing.enabled',
} as const

const DEFAULT_PORT = '8765'
const CUSTOM_HOST = '__custom__'

// HOST serves the `ws` kind, TCP_PORT the `iap` one. Both, so neither silently fails.
const SERVER_COMMAND = 'HOST=0.0.0.0 TCP_PORT=8766 npm run server'

const PLAY_LISTING_URL = 'https://play.google.com/store/apps/details?id=app.switchboard.mobile'

interface LanAddress {
  iface: string
  address: string
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
      className="ml-[5px] inline-flex h-[13px] w-[13px] shrink-0 cursor-help items-center justify-center rounded-full border border-[var(--border)] align-middle text-[9px] leading-none text-[var(--text-muted)]"
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
  const [playQrDataUrl, setPlayQrDataUrl] = useState<string | null>(null)
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
      window.api.settings.get(SETTINGS_KEYS.enabled),
    ])
      .then(([addrs, savedHost, savedPort, savedEnabled]) => {
        if (cancelled) return
        setLanAddrs(addrs)
        const initialHost = savedHost ?? addrs[0]?.address ?? ''
        setHost(initialHost)
        setCustomHost(initialHost !== '' && !addrs.some((a) => a.address === initialHost))
        if (savedPort) setPort(savedPort)
        setEnabled(savedEnabled === 'true')
        setLoaded(true)
      })
      .catch((err) => {
        log.warn('failed to load pairing settings', err)
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Persist on change (post-load only, so defaults don't clobber saved values),
  // then re-apply the endpoint so the QR is live the moment it renders - no
  // restart. The endpoint reads port and enabled back from settings, hence the order.
  useEffect(() => {
    if (!loaded) return
    let cancelled = false
    Promise.all([
      window.api.settings.set(SETTINGS_KEYS.host, host),
      window.api.settings.set(SETTINGS_KEYS.port, port),
      window.api.settings.set(SETTINGS_KEYS.enabled, enabled ? 'true' : 'false'),
    ])
      .then(() => window.api.app.mobilePairingApply())
      .then((status) => {
        if (!cancelled) setEndpoint(status)
      })
      .catch((err) => log.warn('failed to persist/apply pairing settings', err))
    return () => {
      cancelled = true
    }
  }, [loaded, host, port, enabled])

  // The poll and a revoke or rename can each start a refresh; only the latest may land.
  const devicesRequest = useRef(0)
  const refreshDevices = useCallback(() => {
    const request = ++devicesRequest.current
    window.api.app
      .mobileDevices()
      .then((list) => {
        if (request === devicesRequest.current) setDevices(list)
      })
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

  const pairingUrl = useMemo(() => {
    if (!host || !pairing || !isValidPort(port)) return null
    return withCertPin(`ws://${host}:${port}?pair=${pairing.code}`, endpoint?.fingerprint)
  }, [host, port, pairing, endpoint?.fingerprint])
  const shortFp = shortFingerprint(endpoint?.fingerprint)

  // Regenerate the QR whenever the pairing URL changes.
  useEffect(() => {
    if (!pairingUrl) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    QRCode.toDataURL(pairingUrl, { margin: 1, width: 220 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl)
      })
      .catch((err) => {
        log.warn('QR generation failed', err)
        if (!cancelled) setQrDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [pairingUrl])

  // The download QR encodes a static URL, so render it once per mount.
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(PLAY_LISTING_URL, { margin: 1, width: 160 })
      .then((dataUrl) => {
        if (!cancelled) setPlayQrDataUrl(dataUrl)
      })
      .catch((err) => log.warn('Play listing QR generation failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(SERVER_COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      log.warn('clipboard write failed', err)
    }
  }, [])

  // Picking "Custom hostname" moves focus to its field, not back to the picker.
  const customHostInputRef = useRef<HTMLInputElement>(null)
  const focusCustomHostOnClose = useRef(false)
  const onSelectHost = useCallback((value: string) => {
    if (value === CUSTOM_HOST) {
      focusCustomHostOnClose.current = true
      setCustomHost(true)
      setHost('')
    } else {
      setCustomHost(false)
      setHost(value)
    }
  }, [])

  const selectValue = customHost ? CUSTOM_HOST : host
  // One row per address: the same one on two interfaces would be two rows with one value.
  const hostOptions = useMemo(
    () => [
      ...lanAddrs
        .filter((a, i) => lanAddrs.findIndex((b) => b.address === a.address) === i)
        .map((a) => ({ value: a.address, label: `${a.address} (${a.iface})` })),
      { value: CUSTOM_HOST, label: 'Custom hostname…' },
    ],
    [lanAddrs],
  )

  const inputClass =
    'w-full rounded-[4px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-primary)] outline-none'
  const fieldLabelClass = 'mb-1 text-[11px] font-[500] text-[var(--text-secondary)]'
  const canPair = enabled && !!host && isValidPort(port)

  return (
    <div>
      <label className="mb-2.5 flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-primary)]">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Serve the mobile endpoint
        <InfoHint text="Opens a listener on the port below, reachable from your local network, so a paired phone sees the same chats and sessions as this window. Off by default: nothing listens until you turn it on, and turning it off stops it immediately. Paired devices keep their credentials and reconnect when it is on again." />
      </label>
      <div className="mb-3.5 text-[11px] leading-[1.6] text-[var(--text-muted)]">
        {enabled
          ? 'Scan the QR below from the mobile app to pair it with this computer.'
          : 'The endpoint is off. Nothing is listening.'}
      </div>

      {/* Connection fields */}
      <div className="mb-3.5 flex gap-2.5">
        <div className="min-w-0 flex-[2]">
          <div className={fieldLabelClass}>Host</div>
          <Combobox
            searchable={false}
            aria-label="Host"
            value={selectValue}
            onValueChange={onSelectHost}
            options={hostOptions}
            onCloseAutoFocus={(event) => {
              if (!focusCustomHostOnClose.current) return
              focusCustomHostOnClose.current = false
              event.preventDefault()
              customHostInputRef.current?.focus()
            }}
            className="flex w-full rounded-[4px] px-2 py-1.5"
          />
          {customHost && (
            <input
              ref={customHostInputRef}
              autoFocus
              value={host}
              onChange={(e) => setHost(e.target.value.trim())}
              placeholder="vm.tailnet-name.ts.net"
              className={`${inputClass} mt-1.5`}
            />
          )}
        </div>
        <div className="w-[90px] shrink-0">
          <div className={fieldLabelClass}>Port</div>
          <input
            value={port}
            onChange={(e) => setPort(e.target.value.trim())}
            placeholder={DEFAULT_PORT}
            className={inputClass}
          />
        </div>
      </div>

      {/* QR + pairing URL preview */}
      <div className="mb-3.5 flex items-center gap-3.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-tertiary)] px-3.5 py-3">
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt="Pairing QR code"
            width={140}
            height={140}
            className="shrink-0 rounded-[4px] bg-white"
          />
        ) : (
          <div className="flex h-[140px] w-[140px] shrink-0 items-center justify-center rounded-[4px] border border-dashed border-[var(--border)] p-2 text-center text-[10.5px] text-[var(--text-muted)]">
            {!enabled
              ? 'Turn the endpoint on to pair'
              : !isValidPort(port)
                ? 'Port must be 1-65535'
                : !host
                  ? 'Pick an address to render the QR'
                  : 'Tap Show pairing QR'}
          </div>
        )}
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <div className="text-[11px] font-[500] text-[var(--text-secondary)]">Pairing URL</div>
            <button
              onClick={startPairing}
              disabled={!canPair}
              className={`rounded-[4px] border border-[var(--border)] bg-transparent px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] ${host && isValidPort(port) ? 'cursor-pointer' : 'cursor-default'}`}
            >
              {pairing ? 'New code' : 'Show pairing QR'}
            </button>
            {pairing && <span className="text-[10.5px] text-[var(--text-muted)]">expires in {secondsLeft}s</span>}
          </div>
          <div className="break-all font-[family-name:var(--font-mono)] text-[11px] leading-normal text-[var(--text-primary)]">
            {pairingUrl ?? '·'}
          </div>
          <div className="mt-1.5 text-[10.5px] leading-normal text-[var(--text-muted)]">
            Scan from the mobile app. The QR re-renders on every field change.
          </div>
          {endpoint && (
            <div
              className={`mt-2 flex items-center gap-1.5 text-[10.5px] ${endpoint.listening ? 'text-[var(--text-secondary)]' : 'text-[var(--error,#e5544a)]'}`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-[3px] ${endpoint.listening ? 'bg-[var(--success,#3dd17a)]' : 'bg-[var(--error,#e5544a)]'}`}
              />
              {endpoint.listening
                ? `Serving this QR on port ${endpoint.port}`
                : `Not serving: ${endpoint.reason ?? 'unknown'}`}
            </div>
          )}
          {shortFp && (
            <div className="mt-2 text-[10.5px] leading-normal text-[var(--text-muted)]">
              Certificate{' '}
              <span
                data-testid="pairing-short-fingerprint"
                className="[font-family:var(--font-mono)] text-[11px] text-[var(--text-primary)]"
              >
                {shortFp}
              </span>
              . The phone shows the same code next to this computer&apos;s name.
            </div>
          )}
        </div>
      </div>

      {/* Paired devices */}
      <div className={`${fieldLabelClass} mb-2 flex items-center`}>
        Paired devices
        <InfoHint text="Each phone holds its own credential. Revoking one cuts it off at once and leaves the others working. A phone that has not connected for 30 days counts as inactive." />
      </div>
      <div className="mb-3.5">
        <PairedDevices
          devices={devices}
          playListingUrl={PLAY_LISTING_URL}
          canPair={canPair}
          onShowPairing={startPairing}
          onChanged={refreshDevices}
        />
      </div>

      {/* Server command */}
      <div className={fieldLabelClass}>Run on the target machine</div>
      <div className="flex items-start gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5">
        <code className="flex-1 break-all font-[family-name:var(--font-mono)] text-[11px] leading-[1.6] text-[var(--text-primary)]">
          {SERVER_COMMAND}
        </code>
        <button
          onClick={copyCommand}
          className={`shrink-0 cursor-pointer rounded-[4px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-[11px] ${copied ? 'text-[var(--success,#3dd17a)]' : 'text-[var(--text-primary)]'}`}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="mt-2 text-[10.5px] leading-[1.6] text-[var(--text-muted)]">
        Only for a machine with no Switchboard app running, such as a VM. Runs in the foreground, so start it under
        tmux, and pair from the QR it prints.
        <InfoHint text="This computer needs no command: it serves the endpoint itself. On a VM, the server bundle (out/server/index.cjs) must be present first, and binding beyond loopback mints a token and saves it to ~/.switchboard-server/token. TCP_PORT starts a second listener on 8766 speaking ndjson, which is what an IAP-tunnelled phone dials. Running it here as well would take the port and stop the app from serving." />
      </div>

      {/* Android download: Google Play is the only channel */}
      <div className="mt-3.5 flex items-center gap-3.5 rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] px-3.5 py-3">
        {playQrDataUrl && (
          <img
            src={playQrDataUrl}
            alt="Google Play listing QR code"
            width={100}
            height={100}
            className="shrink-0 rounded-[4px] bg-white"
          />
        )}
        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-medium text-[var(--text-secondary)]">Get the app</div>
          <div className="text-[10.5px] leading-normal text-[var(--text-muted)]">
            The Android app is coming to Google Play. This link works once Google approves the listing.
          </div>
          <a
            href={PLAY_LISTING_URL}
            className="mt-1.5 block break-all font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-primary)]"
          >
            {PLAY_LISTING_URL}
          </a>
        </div>
      </div>

      <GoogleMintPanel />
    </div>
  )
}
