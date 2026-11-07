/**
 * Settings > Labs, shown only while the Instinct bridge flag is on: this
 * desktop's enrollment with the bridge relay. Enroll makes a device key that
 * stays on this computer (keychain encrypted) and shows the machine id and the
 * operator command that registers its public key. The status is read again
 * every 2 s while the page is open.
 */
import { useEffect, useRef, useState } from 'react'
import type { BridgeDeviceStatus } from '@shared/bridge'
import { BRIDGE_DEVICE_STATUS } from './bridge-setup-model'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { confirm } from '../ui/confirm'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:bridge-device')
const POLL_MS = 2_000

export function bridgeStatusText(status: BridgeDeviceStatus): string {
  const code = status.code ? ` (${status.code})` : ''
  switch (status.state) {
    case 'off':
      return 'Off'
    case 'not_enrolled':
      return 'Not enrolled'
    case 'connecting':
      return 'Connecting'
    case 'connected':
      return 'Connected'
    case 'retrying':
      return `Not connected${code}. Trying again.`
    case 'rejected':
      return `Refused by the relay${code}. Trying again later.`
    case 'key_unreadable':
      return `The device key cannot be used here${code}. Remove the enrollment and enroll again.`
  }
}

export function BridgeDevicePanel() {
  const [status, setStatus] = useState<BridgeDeviceStatus | null>(null)
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  // A failed status poll, kept apart from action errors so the next good poll clears only it.
  const [readError, setReadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // The stored label last shown, so a poll refreshes the field only when the label changed elsewhere.
  const shownLabel = useRef<string | null | undefined>(undefined)

  const show = (next: BridgeDeviceStatus) => {
    setStatus(next)
    window.dispatchEvent(new CustomEvent(BRIDGE_DEVICE_STATUS, { detail: next }))
    if (shownLabel.current !== next.label) {
      shownLabel.current = next.label
      setLabel(next.label ?? '')
    }
  }

  useEffect(() => {
    let live = true
    let failed = false
    const read = () =>
      window.api.bridge
        .deviceStatus()
        .then((next) => {
          failed = false
          if (!live) return
          setReadError(null)
          show(next)
        })
        .catch((err: unknown) => {
          if (!failed) log.warn('reading the bridge device status failed', err)
          failed = true
          if (!live) return
          window.dispatchEvent(new CustomEvent(BRIDGE_DEVICE_STATUS, { detail: null }))
          setReadError('Could not read the enrollment.')
        })
    void read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const run = async (action: () => Promise<BridgeDeviceStatus>, failure: string) => {
    setBusy(true)
    setError(null)
    try {
      shownLabel.current = undefined
      show(await action())
    } catch (err) {
      log.warn(failure, err)
      setError(err instanceof Error ? err.message : failure)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const ok = await confirm({
      title: 'Remove enrollment?',
      body: 'This deletes the device key on this Mac and disconnects it from the bridge relay. Revoke the device at the relay too, with the operator revoke command.',
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (ok) await run(() => window.api.bridge.removeDevice(), 'Could not remove the enrollment.')
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      log.warn('copying the operator command failed', err)
      setError('Could not copy the command.')
    }
  }

  const shownError = error ?? readError
  if (!status?.enabled && !shownError) return null
  const enrolled = status?.enrolled === true
  return (
    <section className="mb-[18px]" data-testid="bridge-device">
      <h3 className="mb-2 text-[11px] font-[500] leading-4 text-[var(--text-muted)]">Instinct bridge device</h3>
      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
        <p className="m-0 px-[14px] pb-1 pt-3 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
          Enroll this Mac so the bridge relay can reach it. The device key stays here, encrypted by the keychain; only
          its public half goes to the relay.
        </p>
        <Row name="Status">
          <span data-testid="bridge-device-status">{status ? bridgeStatusText(status) : 'Reading'}</span>
        </Row>
        {status && (
          <Row name="Machine id">
            <Code>{status.machine_id}</Code>
          </Row>
        )}
        <Row name="Label">
          <div className="flex items-center gap-2">
            <Input
              aria-label="Device label"
              value={label}
              maxLength={100}
              placeholder="This Mac"
              disabled={busy}
              onChange={(e) => setLabel(e.target.value)}
              className="h-7 w-[220px] text-[12px]"
            />
            {enrolled && label.trim() !== (status?.label ?? '') && label.trim() !== '' && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => window.api.bridge.setDeviceLabel(label), 'Could not save the label.')}
              >
                Save
              </Button>
            )}
          </div>
        </Row>
        {enrolled && status?.key_fingerprint && (
          <Row name="Key fingerprint">
            <Code>{status.key_fingerprint}</Code>
          </Row>
        )}
        {enrolled && status?.operator_command && (
          <div className="border-t border-[var(--border)] px-[14px] py-2.5">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[12px] text-[var(--text-secondary)]">Register this Mac at the relay</span>
              <Button size="sm" variant="ghost" onClick={() => void copy(status.operator_command!)}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre
              data-testid="bridge-operator-command"
              className="m-0 whitespace-pre-wrap break-all rounded-[6px] bg-[var(--bg-secondary)] p-2 [font-family:var(--font-mono)] text-[11px] text-[var(--text-primary)]"
            >
              {status.operator_command}
            </pre>
            <p className="m-0 mt-1 text-[11px] leading-[1.45] text-[var(--text-muted)]">
              Paste it in any folder. It needs the operator key from Secret Manager, which is not your login.
            </p>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-[14px] py-2.5">
          {enrolled ? (
            <Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => void remove()}>
              Remove enrollment
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy || !status}
              onClick={() => void run(() => window.api.bridge.enrollDevice(label), 'Could not enroll this Mac.')}
            >
              Enroll this Mac
            </Button>
          )}
        </div>
        {shownError && (
          <p
            role="alert"
            className="m-0 border-t border-[var(--border)] px-[14px] py-2 text-[12px] text-[var(--error)]"
          >
            {shownError}
          </p>
        )}
      </div>
    </section>
  )
}

export function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[40px] items-center justify-between gap-3 border-t border-[var(--border)] px-[14px] py-2 text-[12px]">
      <span className="text-[var(--text-secondary)]">{name}</span>
      <span className="min-w-0 truncate text-right text-[var(--text-primary)]">{children}</span>
    </div>
  )
}

export function Code({ children }: { children: React.ReactNode }) {
  return <code className="[font-family:var(--font-mono)] text-[11px] text-[var(--text-primary)]">{children}</code>
}
