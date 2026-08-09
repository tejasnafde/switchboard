/**
 * Mint a Google refresh token for the phone, from the desktop app.
 *
 * Replaces the instruction to run `node scripts/google-mint-token.mjs`, which
 * needed the repo checked out and a `personal`-configured gcloud. Consent still
 * has to happen on the desktop - Google blocks custom-scheme redirects on
 * Android - but nothing here needs a terminal.
 */
import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { createRendererLogger } from '../../logger'
import type { GoogleClientStatus } from '../../../main/google/client-config'

const log = createRendererLogger('settings:google-mint')

const CARD: React.CSSProperties = {
  padding: '12px 14px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  background: 'var(--bg-tertiary)',
  marginTop: '14px',
}

const LABEL: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 500,
  color: 'var(--text-secondary)',
  marginBottom: '4px',
}

const HINT: React.CSSProperties = {
  fontSize: '10.5px',
  color: 'var(--text-muted)',
  lineHeight: 1.5,
}

const INPUT: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: '4px',
  color: 'var(--text-primary)',
}

export function GoogleMintPanel(): React.JSX.Element {
  const [status, setStatus] = useState<GoogleClientStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [editing, setEditing] = useState(false)
  const [minting, setMinting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [blob, setBlob] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.api.app
      .googleClientStatus()
      .then(setStatus)
      .catch((err: unknown) => log.warn('could not read the google client status', err))
  }, [])

  useEffect(refresh, [refresh])

  const openEditor = (): void => {
    // Prefilled, so editing one field does not require retyping the other.
    setClientId(status?.clientId ?? '')
    setClientSecret('')
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    setError(null)
    try {
      // The secret is omitted when left blank rather than sent as '': absent
      // means "keep what is stored", and the field always renders empty.
      setStatus(
        await window.api.app.googleSetClient({
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
        }),
      )
      setEditing(false)
      setClientSecret('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const mint = async (): Promise<void> => {
    setMinting(true)
    setError(null)
    setQrDataUrl(null)
    setBlob(null)
    try {
      const result = await window.api.app.googleMint()
      setBlob(result.blob)
      // Error correction stays low: the payload is long, and a denser code is
      // harder for a phone camera than a slightly less redundant one.
      setQrDataUrl(await QRCode.toDataURL(result.blob, { margin: 1, width: 220, errorCorrectionLevel: 'L' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMinting(false)
    }
  }

  const configured = status?.configured === true

  return (
    <div style={CARD}>
      <div style={LABEL}>Google account for work VMs</div>
      <div style={HINT}>
        Needed only to reach work VMs over IAP with your laptop closed. Consent happens here because
        Google does not allow the phone to complete this sign-in itself.
      </div>

      {!configured && !editing && (
        <div style={{ ...HINT, marginTop: '8px', color: 'var(--text-secondary)' }}>
          No OAuth client configured yet.{' '}
          <button
            onClick={openEditor}
            style={{ ...HINT, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            Add one
          </button>
        </div>
      )}

      {configured && !editing && (
        <div style={{ ...HINT, marginTop: '8px' }}>
          Using{' '}
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
            {status?.clientId}
          </span>{' '}
          {status?.source === 'env' ? '(from the environment)' : ''}
          {status?.source === 'settings' && (
            <button
              onClick={openEditor}
              style={{ ...HINT, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              change
            </button>
          )}
        </div>
      )}

      {editing && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={HINT}>
            A Desktop-type OAuth client from Google Cloud. The secret is not a real secret for this
            client type - PKCE is what protects the exchange - but the token it mints is, so treat
            the QR below like a password.
          </div>
          <input
            style={INPUT}
            placeholder="Client ID"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <input
            style={INPUT}
            placeholder={status?.configured ? "Client secret (unchanged if blank)" : "Client secret (optional)"}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={() => void save()}>Save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}

      {configured && !editing && (
        <button onClick={() => void mint()} disabled={minting} style={{ marginTop: '10px' }}>
          {minting ? 'Waiting for Google sign-in...' : 'Connect Google account'}
        </button>
      )}

      {error && (
        <div style={{ ...HINT, marginTop: '8px', color: 'var(--error, #f87171)' }}>{error}</div>
      )}

      {qrDataUrl && (
        <div style={{ display: 'flex', gap: '14px', alignItems: 'center', marginTop: '12px' }}>
          <img
            src={qrDataUrl}
            alt="Google credentials QR code"
            width={160}
            height={160}
            style={{ borderRadius: '4px', background: '#fff', flexShrink: 0 }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={LABEL}>Scan on the phone</div>
            <div style={HINT}>
              Account &gt; Scan QR from desktop. This grants cloud-platform access as you, so do not
              share it or leave it on screen.
            </div>
            <button onClick={() => void navigator.clipboard.writeText(blob ?? '')} style={{ marginTop: '6px' }}>
              Copy instead
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
