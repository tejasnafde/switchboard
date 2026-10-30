/**
 * An agent's secret request (`request_secret`): the card with a masked input,
 * and the one-line saved, declined or expired state after it closes.
 *
 * The value lives only in the input element. It is never React state, a
 * store, a draft or a log line: Save reads it, clears the field and sends it
 * once over `agent-secret:answer`. Keys typed in the card stop here, so the
 * composer and the shortcuts never see them.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ChatMessage } from '@shared/types'
import {
  SECRET_CARD_HEADER,
  type AgentSecretView,
  type SecretRequestCard as SecretCard,
} from '@shared/agent-secret-request'
import type { ApprovalResultRow } from '@shared/agent-approval-cards'
import { Button } from '../ui/button'
import { confirm } from '../ui/confirm'
import { cn } from '../../lib/utils'
import { useAgentStore } from '../../stores/agent-store'
import { useMachineStore } from '../../stores/machine-store'
import { createRendererLogger } from '../../logger'
import {
  PROVIDER_KEY_NOTE,
  SECRET_CARD_ATTR,
  SECRET_REVEAL_MS,
  SECRET_TRIMMED_TEXT,
  asksForProviderKey,
  secretFooterText,
  secretStorageNotes,
  secretLineState,
  secretNameFromResultTitle,
  secretTimeLeftText,
  secretValueSavable,
  splitInstructionUrls,
  trimSecretValue,
  type SecretLineState,
} from './secret-request-card-model'

const log = createRendererLogger('chat:secret-card')

const LIST_REFRESH_MS = 60_000
const CLOCK_TICK_MS = 30_000

/** Card titles by card id, so the collapsed line keeps the title as its tooltip after the card goes. */
const cardTitles = new Map<string, string>()
/** Cards this window declined, so the line reads Declined until the result row replaces it. */
const declinedCards = new Set<string>()

const stopKeys = (e: ReactKeyboardEvent) => e.stopPropagation()

/** The SSH machine a chat runs on, by its name in the sidebar; undefined for this computer. */
function useMachineLabel(sessionId: string | undefined): string | undefined {
  const machineId = useAgentStore((s) =>
    sessionId === undefined ? undefined : s.sessions.find((x) => x.id === sessionId)?.machineId,
  )
  return useMachineStore((s) =>
    machineId && machineId !== 'local' ? (s.remotes.find((m) => m.id === machineId)?.name ?? machineId) : undefined,
  )
}

async function openInstructionLink(url: string): Promise<void> {
  if (!(await confirm({ title: 'Open this link?', body: url, confirmLabel: 'Open' }))) return
  // The window-open handler in main sends http(s) links to the system browser.
  window.open(url, '_blank', 'noopener,noreferrer')
}

function Instructions({ text }: { text: string }) {
  return (
    <div className="mt-1 whitespace-pre-wrap text-[12px] leading-[1.5] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
      {splitInstructionUrls(text).map((part, i) =>
        part.kind === 'text' ? (
          <span key={i}>{part.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            title={part.url}
            onClick={() => void openInstructionLink(part.url)}
            className="inline cursor-pointer border-none bg-transparent p-0 text-left text-[var(--text-secondary)] hover:underline"
          >
            <b className="font-[600] text-[var(--text-primary)]">{part.host}</b>
            {part.rest}
          </button>
        ),
      )}
    </div>
  )
}

export function SecretRequestCard({ message, sessionId }: { message: ChatMessage; sessionId?: string }) {
  const card = message.approval?.secretRequest
  const machine = useMachineLabel(sessionId)
  if (!message.approval || !card) return null
  const cardId = message.id.replace('approval_', '')
  cardTitles.set(cardId, card.title)
  if (message.approval.status !== 'pending') {
    // Until the result row replaces it: the backend's result names the exact outcome.
    const state: SecretLineState =
      message.approval.status === 'accepted'
        ? { kind: 'saved', expiresAt: null, secretId: null }
        : { kind: declinedCards.has(cardId) ? 'declined' : 'expired' }
    return (
      <SecretLineFrame title={card.title} state={state.kind} className="mt-2">
        <SecretLineBody name={card.name} state={state} machine={card.machineLabel ?? machine} />
      </SecretLineFrame>
    )
  }
  return <PendingSecretCard card={card} cardId={cardId} sessionId={sessionId} machine={card.machineLabel ?? machine} />
}

function PendingSecretCard({
  card,
  cardId,
  sessionId,
  machine,
}: {
  card: SecretCard
  cardId: string
  sessionId?: string
  machine?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [canSave, setCanSave] = useState(false)
  const [willTrim, setWillTrim] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [submitting, setSubmitting] = useState<null | 'save' | 'decline'>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!revealed) return
    const timer = setTimeout(() => setRevealed(false), SECRET_REVEAL_MS)
    return () => clearTimeout(timer)
  }, [revealed])

  // Checked on every input event; only the two answers are kept, never the value.
  const onInput = () => {
    const raw = inputRef.current?.value ?? ''
    setCanSave(secretValueSavable(raw))
    setWillTrim(trimSecretValue(raw).trimmed)
  }

  const send = async (kind: 'save' | 'decline') => {
    if (submitting || !sessionId) return
    const input = inputRef.current
    let answer: { save: string } | { decline: true } = { decline: true }
    if (kind === 'save') {
      if (!input || !secretValueSavable(input.value)) return
      answer = { save: trimSecretValue(input.value).value }
    }
    if (input) input.value = ''
    setCanSave(false)
    setRevealed(false)
    setSubmitting(kind)
    setError(null)
    try {
      const result = await window.api.agentSecret.answer(sessionId, cardId, answer)
      if (result.ok) {
        if (kind === 'decline') declinedCards.add(cardId)
        return
      }
      setError(result.message)
    } catch (err) {
      log.warn('secret answer failed', { cardId, kind, message: err instanceof Error ? err.message : 'unknown' })
      setError('Could not send the answer. Try again.')
    }
    setSubmitting(null)
  }

  const footer = secretFooterText(card.ttl, machine)
  const storageNotes = secretStorageNotes(card)
  return (
    <div
      {...{ [SECRET_CARD_ATTR]: '' }}
      data-testid="secret-request-card"
      data-status="pending"
      onKeyDown={stopKeys}
      onKeyUp={stopKeys}
      className="mt-2 overflow-hidden rounded-md border border-[var(--warning)] bg-[rgba(210,153,34,0.06)]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <TerminalIcon />
        <span className="text-[11px] font-[600] text-[var(--text-secondary)]">{SECRET_CARD_HEADER}</span>
      </div>
      <div className="px-3 pb-1 pt-2.5">
        <div className="text-[13px] font-[600] text-[var(--text-primary)] [overflow-wrap:anywhere]">{card.title}</div>
        <Instructions text={card.instructions} />
        {asksForProviderKey(card.name, card.title) && (
          <div data-testid="secret-provider-key-note" className="mt-1.5 text-[12px] text-[var(--text-secondary)]">
            {PROVIDER_KEY_NOTE}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            type={revealed ? 'text' : 'password'}
            autoComplete="new-password"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-label={card.name}
            placeholder="Paste the key"
            disabled={submitting !== null}
            onInput={onInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void send('save')
              }
            }}
            className={cn(
              'block h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] pl-2.5 pr-[34px] text-[13px] text-[var(--text-primary)] outline-none focus-visible:border-[var(--border-focus)] focus-visible:shadow-[0_0_0_3px_var(--accent-subtle)]',
              revealed && 'font-[family-name:var(--font-mono)] text-[12px]',
            )}
          />
          <button
            type="button"
            aria-label={revealed ? 'Hide' : 'Show for 10 seconds'}
            title={revealed ? 'Hide' : 'Show for 10 seconds'}
            onClick={() => setRevealed((v) => !v)}
            className="absolute right-1.5 top-1/2 inline-flex size-[22px] -translate-y-1/2 cursor-pointer items-center justify-center rounded-[4px] border-none bg-transparent p-0 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <EyeIcon />
          </button>
        </div>
        <Button size="sm" disabled={!canSave || submitting !== null || !sessionId} onClick={() => void send('save')}>
          {submitting === 'save' ? 'Saving' : 'Save securely'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={submitting !== null || !sessionId}
          onClick={() => void send('decline')}
        >
          Decline
        </Button>
      </div>
      {error && (
        <div role="alert" className="px-3 pb-1 text-[12px] text-[var(--error)]">
          {error}
        </div>
      )}
      {storageNotes.length > 0 && (
        <div data-testid="secret-storage-note" className="px-3 pb-1 text-[11px] text-[var(--warning)]">
          {storageNotes.join(' ')}
        </div>
      )}
      <div data-testid="secret-footer" className="px-3 pb-2 text-[11px] text-[var(--text-muted)]">
        {willTrim ? `${footer} ${SECRET_TRIMMED_TEXT}.` : footer}
      </div>
    </div>
  )
}

function SecretLineFrame({
  title,
  state,
  className,
  children,
}: {
  title: string
  state: SecretLineState['kind']
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      {...{ [SECRET_CARD_ATTR]: '' }}
      data-testid="secret-line"
      data-state={state}
      title={title}
      onKeyDown={stopKeys}
      onKeyUp={stopKeys}
      className={cn('overflow-hidden rounded-md border border-[var(--border)]', className)}
    >
      {children}
    </div>
  )
}

function SecretLineBody({
  name,
  state,
  machine,
  now = Date.now(),
  actions,
}: {
  name: string
  state: SecretLineState
  machine?: string
  now?: number
  actions?: React.ReactNode
}) {
  const nameEl = <span className="font-[family-name:var(--font-mono)] text-[12px]">{name}</span>
  const left = state.kind === 'saved' && state.expiresAt !== null ? secretTimeLeftText(state.expiresAt, now) : null
  return (
    <div
      className={cn(
        'flex min-h-9 items-center gap-2 px-3 py-1.5 text-[13px]',
        state.kind === 'saved' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
      )}
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {state.kind === 'saved' && (
          <>
            Saved {nameEl}
            {machine ? ` on ${machine}` : ''}
            {left && (
              <>
                , <span className="text-[var(--text-muted)]">{left}</span>
              </>
            )}
          </>
        )}
        {state.kind === 'declined' && <>Declined {nameEl}</>}
        {state.kind === 'expired' && <>{nameEl} expired</>}
        {state.kind === 'deleted' && <>{nameEl} deleted</>}
      </span>
      <span className="flex-1" />
      {actions}
    </div>
  )
}

/** The chat's saved secrets, read on mount and every minute; null until the first read answers. */
function useChatSecrets(sessionId: string | undefined): {
  secrets: AgentSecretView[] | null
  reload: () => void
} {
  const [secrets, setSecrets] = useState<AgentSecretView[] | null>(null)
  const reload = useCallback(() => {
    if (!sessionId) return
    window.api.agentSecret
      .list(sessionId)
      .then((result) => {
        if (result.ok) setSecrets(result.secrets)
        else log.info('saved secrets not listed', { sessionId, message: result.message })
      })
      .catch((err) => log.warn('could not list saved secrets', { sessionId, err }))
  }, [sessionId])
  useEffect(() => {
    reload()
    const timer = setInterval(reload, LIST_REFRESH_MS)
    return () => clearInterval(timer)
  }, [reload])
  return { secrets, reload }
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * The stored result row of a secret card, as its collapsed line: Saved with
 * the time left, Extend and Delete now; Declined; expired or deleted.
 */
export function SecretResultLine({
  row,
  messageId,
  sessionId,
}: {
  row: ApprovalResultRow
  messageId: string
  sessionId?: string
}) {
  const name = secretNameFromResultTitle(row.title)
  const machine = useMachineLabel(sessionId)
  const { secrets, reload } = useChatSecrets(row.outcome === 'done' ? sessionId : undefined)
  const now = useNow()
  const [override, setOverride] = useState<{ expiresAt?: number; deleted?: boolean }>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  let state = secretLineState(row.outcome, row.requestId, secrets, now)
  if (override.deleted) state = { kind: 'deleted' }
  else if (state.kind === 'saved' && override.expiresAt !== undefined)
    state = { ...state, expiresAt: override.expiresAt }

  const act = async (kind: 'extend' | 'delete', secretId: string) => {
    if (busy || !sessionId) return
    setBusy(true)
    setError(null)
    try {
      if (kind === 'extend') {
        const result = await window.api.agentSecret.extend(sessionId, secretId)
        if (result.ok) setOverride({ expiresAt: result.expiresAt })
        else setError(result.message)
      } else {
        const result = await window.api.agentSecret.delete(sessionId, secretId)
        if (result.ok) setOverride({ deleted: true })
        else setError(result.message)
      }
    } catch (err) {
      log.warn(`secret ${kind} failed`, { secretId, err })
      setError('Could not reach the backend. Try again.')
    }
    setBusy(false)
    reload()
  }

  const secretId = state.kind === 'saved' ? state.secretId : null
  return (
    <div data-message-id={messageId} className="mx-4 my-2">
      <SecretLineFrame title={cardTitles.get(row.requestId) ?? name} state={state.kind}>
        <SecretLineBody
          name={name}
          state={state}
          machine={machine}
          now={now}
          actions={
            secretId && (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('extend', secretId)}>
                  Extend
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('delete', secretId)}>
                  Delete now
                </Button>
              </>
            )
          }
        />
        {error && (
          <div role="alert" className="px-3 pb-1.5 text-[12px] text-[var(--error)]">
            {error}
          </div>
        )}
      </SecretLineFrame>
    </div>
  )
}

function TerminalIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none text-[var(--text-secondary)]"
      aria-hidden
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
