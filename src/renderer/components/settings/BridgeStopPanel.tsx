/**
 * Settings > Labs: stop all bridge work on this Mac and see the stop state.
 * The status is read again every 2 s while the page is open. On an enrolled
 * Mac the kill follows the relay, so the page shows the operator command that
 * clears it; on a Mac that is not enrolled a local button clears it.
 *
 * The panel is shown while the Instinct bridge flag is on, and also while the
 * flag is off if a stop is still in force or a bridge chat is still active.
 * Turning the flag off refuses new bridge work; it must never hide the only
 * control that clears a kill, or the state of work that is still running.
 */
import { useEffect, useState } from 'react'
import type { BridgeStopStatus } from '@shared/bridge'
import { Button } from '../ui/button'
import { confirm } from '../ui/confirm'
import { createRendererLogger } from '../../logger'
import { Row } from './BridgeDevicePanel'

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

/** Nothing to show for a Mac that never ran bridge work and has no stop in force. */
export function stopPanelIsIdle(status: BridgeStopStatus | null): boolean {
  return (
    status !== null &&
    !status.killed &&
    !status.kill_pending &&
    status.stop_generation === 0 &&
    status.active_chats === 0 &&
    status.last_result === null &&
    !status.enrolled
  )
}

export function BridgeStopPanel({ flagOn }: { flagOn: boolean }) {
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
  if (!flagOn && stopPanelIsIdle(status)) return null
  return (
    <section className="mb-[18px]" data-testid="bridge-stop">
      <h3 className="mb-2 text-[11px] font-[500] leading-4 text-[var(--text-muted)]">Instinct bridge stop</h3>
      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
        <p className="m-0 px-[14px] pb-1 pt-3 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
          Stop all bridge work stops every chat the bridge started or messaged here, and refuses new bridge work. It can
          interrupt a turn you started when the bridge steered a message into it, and it does not undo a commit, push or
          other action that already happened.
        </p>
        <Row name="Bridge work">
          <span data-testid="bridge-stop-killed">
            {status ? (status.killed ? 'Stopped. New bridge work is refused.' : 'Allowed') : 'Reading'}
          </span>
        </Row>
        {status && (
          <>
            <Row name="Active bridge chats">{status.active_chats}</Row>
            <Row name="Last stop">
              <span data-testid="bridge-stop-result">{lastStopText(status)}</span>
            </Row>
            <details className="group border-t border-[var(--border)] text-[12px]">
              <summary className="flex h-[34px] cursor-pointer select-none list-none items-center gap-1 px-[14px] text-[11px] text-[var(--text-muted)] outline-none hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--switch-focus)] [&::-webkit-details-marker]:hidden">
                <span
                  aria-hidden="true"
                  className="mb-px mr-0.5 size-[5px] -rotate-45 border-b-[1.5px] border-r-[1.5px] border-current transition-transform duration-100 group-open:mb-[3px] group-open:rotate-45"
                />
                Relay details
              </summary>
              <Row name="Stop generation">
                <span data-testid="bridge-stop-generation">
                  {status.stop_generation}
                  {status.kill_pending ? ' (not sent to the relay yet)' : ''}
                </span>
              </Row>
              <Row name="Last relay contact">{clock(status.last_contact_at)}</Row>
              <Row name="Relay work stops at">{clock(status.lease_expires_at)}</Row>
            </details>
          </>
        )}
        {clearCommand && (
          <div className="border-t border-[var(--border)] px-[14px] py-2.5">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[12px] text-[var(--text-secondary)]">
                This Mac is enrolled, so the stop follows the relay. To allow bridge work again, run:
              </span>
              <Button size="sm" variant="ghost" onClick={() => void copy(clearCommand)}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre className="m-0 whitespace-pre-wrap break-all rounded-[6px] bg-[var(--bg-secondary)] p-2 [font-family:var(--font-mono)] text-[11px] text-[var(--text-primary)]">
              <span data-testid="bridge-clear-command">{clearCommand}</span>
            </pre>
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
