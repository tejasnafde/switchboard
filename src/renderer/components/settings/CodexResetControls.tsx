/**
 * A Codex card's banked resets: the "Resets available" line, the inline
 * confirm, the locked "Applying reset…" state and the result banner. Rules
 * and copy live in `@shared/codex-reset`; main owns the idempotency key.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProviderUsage } from '@shared/provider-usage'
import {
  canOfferReset,
  resetConfirmRows,
  resetCreditLines,
  resetResultBanner,
  resetsExpiryNote,
  soonestCreditId,
  type CodexResetOutcome,
  type ResetBannerTone,
} from '@shared/codex-reset'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

type Phase =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'applying' }
  | { kind: 'result'; outcome: CodexResetOutcome }

const BANNER_CLASS: Record<ResetBannerTone, string> = {
  good: 'border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)]',
  info: 'border-[var(--border)] bg-[var(--bg-hover)]',
  bad: 'border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_7%,transparent)]',
}

function Stroke({ d, size }: { d: string; size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

const CHECK_PATH = 'M5 12.5l4.5 4.5L19 7.5'
const CROSS_PATH = 'M6 6l12 12M18 6L6 18'

const ICON: Record<ResetBannerTone, { glyph: ReactNode; color: string }> = {
  good: { glyph: <Stroke d={CHECK_PATH} size={12} />, color: 'text-[var(--success)]' },
  info: { glyph: 'i', color: 'text-[var(--text-secondary)]' },
  bad: { glyph: '!', color: 'text-[var(--error)]' },
}

export function CodexResetControls({
  usage,
  onConsume,
}: {
  usage: ProviderUsage | undefined
  onConsume: (creditId: string | null) => Promise<CodexResetOutcome>
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // Codex said no window was eligible: wait for one at its limit.
  const [afterNothingToReset, setAfterNothingToReset] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const count = usage?.status === 'ok' ? usage.resetCredits?.availableCount ?? null : null
  const offered = canOfferReset(usage, afterNothingToReset)
  const showing = phase.kind !== 'idle'
  if (count === null || (count === 0 && !showing)) return null

  async function spend() {
    setPhase({ kind: 'applying' })
    const outcome = await onConsume(soonestCreditId(usage))
    if (!mounted.current) return
    if (outcome === 'nothingToReset') setAfterNothingToReset(true)
    setPhase({ kind: 'result', outcome })
  }

  if (phase.kind === 'confirm') {
    return (
      <div
        role="alertdialog"
        aria-label="Use a Codex reset"
        className="mt-[10px] rounded-[8px] border border-[var(--border-focus)] bg-[var(--bg-elevated)] p-3 shadow-[var(--shadow-md)]"
      >
        <h4 className="m-0 mb-2 text-[13px] font-[600]">Use a reset?</h4>
        <ul className="m-0 mb-[10px] grid list-none gap-[5px] p-0 text-[12px] text-[var(--text-secondary)]">
          {resetConfirmRows(usage).map((row) => (
            <li key={row.key} className="flex gap-2">
              <span className="w-[92px] shrink-0 text-[var(--text-muted)]">{row.key}</span>
              <span className="text-[var(--text-primary)]">{row.value}</span>
            </li>
          ))}
        </ul>
        <div className="mb-[10px] text-[11.5px] text-[var(--warning)]">This cannot be undone.</div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })}>Cancel</Button>
          <Button size="sm" autoFocus onClick={() => void spend()}>Use reset</Button>
        </div>
      </div>
    )
  }

  const banner = phase.kind === 'result' && usage ? resetResultBanner(phase.outcome, usage, Date.now()) : null
  const note = resetsExpiryNote(usage)
  const lines = resetCreditLines(usage)

  let action: ReactNode = null
  if (phase.kind === 'applying') {
    action = (
      <Button variant="outline" size="sm" className="ml-auto" disabled>
        <span aria-hidden="true" className="inline-block size-[11px] rounded-full border-[1.5px] border-current border-r-transparent motion-safe:animate-spin" />
        Applying reset…
      </Button>
    )
  } else if (banner?.retry) {
    action = <Button variant="outline" size="sm" className="ml-auto" onClick={() => void spend()}>Try again</Button>
  } else if (offered) {
    action = <Button variant="outline" size="sm" className="ml-auto" onClick={() => setPhase({ kind: 'confirm' })}>Use reset</Button>
  }

  return (
    <>
      <div data-codex-resets className="mt-[10px] flex min-h-[26px] items-center gap-[10px] text-[12px] text-[var(--text-secondary)]">
        <span title={lines.length > 0 ? lines.join('\n') : undefined}>
          Resets available: <span className="tabular-nums text-[var(--text-primary)]">{count}</span>
        </span>
        {note && (
          <>
            <span className="text-[var(--text-muted)]">·</span>
            <span className="text-[var(--text-muted)]">{note}</span>
          </>
        )}
        {action}
      </div>
      {banner && (
        <div
          role={banner.tone === 'bad' ? 'alert' : 'status'}
          className={cn('mt-[10px] flex items-start gap-2 rounded-[6px] border px-[10px] py-2 text-[12px] leading-[1.45]', BANNER_CLASS[banner.tone])}
        >
          <span aria-hidden="true" className={cn('flex h-[17px] w-[14px] shrink-0 items-center justify-center font-[700]', ICON[banner.tone].color)}>{ICON[banner.tone].glyph}</span>
          <span>{banner.text}</span>
          {!banner.retry && (
            <button
              type="button"
              aria-label="Dismiss"
              className="ml-auto flex h-[17px] cursor-pointer items-center border-0 bg-transparent p-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              onClick={() => setPhase({ kind: 'idle' })}
            >
              <Stroke d={CROSS_PATH} size={11} />
            </button>
          )}
        </div>
      )}
    </>
  )
}
