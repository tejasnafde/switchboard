/**
 * Settings > Labs, shown while the Instinct bridge flag is on: stop all
 * bridge work on this Mac and see the stop state. The status is read again
 * every 2 s while the page is open. On an enrolled Mac the kill follows the
 * relay, so the page shows the operator command that clears it; on a Mac
 * that is not enrolled a local button clears it.
 */
import { useEffect, useState } from 'react'
import type { BridgeStopStatus } from '@shared/bridge'
import { Button } from '../ui/button'
import { confirm } from '../ui/confirm'
import { createRendererLogger } from '../../logger'
import { Code, Row } from './BridgeDevicePanel'

const log = createRendererLogger('settings:bridge-stop')
const POLL_MS = 2_000

function clock(ms: number | null): string {
  return ms === null ? 'None in this session' : new Date(ms).toLocaleTimeString()
}

export function lastStopText(status: BridgeStopStatus): string {
  const result = status.last_result
  if (!result) return 'None'
  const chats = result.stopped === 1 ? '1 chat stopped' : `${result.stopped} chats stopped`
  if (result.state === 'confirmed') return `Confirmed, ${chats}`
  if (result.unconfirmed_titles.length === 0) return 'Not confirmed'
  return `Not confirmed for: ${result.unconfirmed_titles.join(', ')}`
}

export function BridgeStopPanel() {
  const [status, setStatus] = useState<BridgeStopStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    let failed = false
    const read = () =>
      window.api.bridge
        .stopStatus()
        .then((next) => {
          failed = false
          if (!live) return
          setReadError(null)
          setStatus(next)
        })
        .catch((err: unknown) => {
          if (!failed) log.warn('reading the bridge stop status failed', err)
          failed = true
          if (live) setReadError('Could not read the stop status.')
        })
    void read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const run = async (action: () => Promise<BridgeStopStatus>, failure: string) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (err) {
      log.warn(failure, err)
      setError(err instanceof Error ? err.message : failure)
    } finally {
      setBusy(false)
    }
  }

  const stopAll = async () => {
    const ok = await confirm({
      title: 'Stop all bridge work?',
      body: 'This stops every chat the bridge started or messaged on this Mac, and refuses new bridge work until it is allowed again. It also interrupts a turn you started when the bridge steered a message into it.',
      confirmLabel: 'Stop all',
      destructive: true,
    })
    if (ok) await run(() => window.api.bridge.stopAll(), 'Could not stop bridge work.')
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      log.warn('copying the clear command failed', err)
      setError('Could not copy the command.')
    }
  }

  const shownError = error ?? readError
  const clearCommand = status?.clear_command ?? null
  return (
    <section className="mb-[18px]" data-testid="bridge-stop">
      <h3 className="mb-2 text-[11px] font-[500] leading-4 text-[var(--text-muted)]">Instinct bridge stop</h3>
      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
        <p className="m-0 px-[14px] pb-1 pt-3 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
          Stop all bridge work stops every chat the bridge started or messaged on this Mac and refuses new bridge work.
          A stop also interrupts a turn you started when the bridge steered a message into it. It does not undo a
          commit, push or other action that already happened.
        </p>
        <Row name="Bridge work">
          <span data-testid="bridge-stop-killed">
            {status ? (status.killed ? 'Stopped. New bridge work is refused.' : 'Allowed') : 'Reading'}
          </span>
        </Row>
        {status && (
          <>
            <Row name="Stop generation">
              <span data-testid="bridge-stop-generation">
                {status.stop_generation}
                {status.kill_pending ? ' (not sent to the relay yet)' : ''}
              </span>
            </Row>
            <Row name="Last stop">
              <span data-testid="bridge-stop-result">{lastStopText(status)}</span>
            </Row>
            <Row name="Active bridge chats">{status.active_chats}</Row>
            <Row name="Last relay contact">{clock(status.last_contact_at)}</Row>
            <Row name="Relay work stops at">{clock(status.lease_expires_at)}</Row>
          </>
        )}
        {clearCommand && (
          <div className="border-t border-[var(--border)] px-[14px] py-2.5">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[12px] text-[var(--text-secondary)]">
                This Mac is enrolled, so the kill follows the relay. To allow bridge work again, run in a Switchboard
                checkout:
              </span>
              <Button size="sm" variant="ghost" onClick={() => void copy(clearCommand)}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <Code>
              <span data-testid="bridge-clear-command">{clearCommand}</span>
            </Code>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-[14px] py-2.5">
          {status?.killed && !status.enrolled && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => window.api.bridge.clearKill(), 'Could not allow bridge work again.')}
            >
              Allow bridge work again
            </Button>
          )}
          <Button size="sm" variant="destructive" disabled={busy || !status} onClick={() => void stopAll()}>
            Stop all bridge work
          </Button>
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
