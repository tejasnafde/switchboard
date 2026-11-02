import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  DEFAULT_SNOOZE_PRESETS,
  MAX_SNOOZE_PRESETS,
  presetListRefusalText,
  presetTiming,
  type SnoozePresetSpec,
} from '@shared/chat-snooze'
import { useSnoozePresetsStore } from '../../stores/snooze-presets-store'
import { createRendererLogger } from '../../logger'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { confirm } from '../ui/confirm'
import {
  DAY_OPTIONS,
  KIND_OPTIONS,
  LAST_ROW_REASON,
  LIMIT_REASON,
  UNIT_OPTIONS,
  WEEKDAY_OPTIONS,
  blankDraft,
  checkDraft,
  draftFromSpec,
  draftName,
  listToSave,
  markSaved,
  menuHint,
  normalizeField,
  previewAtText,
  resetBody,
  rowNotice,
  shownErrors,
  standings,
  statusLine,
  whenText,
  type DraftField,
  type PresetDraft,
  type PresetStanding,
  type SaveState,
} from './snooze-presets-model'

const log = createRendererLogger('settings:snooze-presets')

let nextId = 0
const newId = () => `snz-${++nextId}`
const draftsOf = (specs: readonly SnoozePresetSpec[]) => specs.map((spec) => draftFromSpec(newId(), spec))

interface Committed {
  /** Each saved row's spec, in list order. */
  rows: Array<{ id: string; spec: SnoozePresetSpec }>
  at: Date
}

function committedOf(drafts: readonly PresetDraft[], at: Date): Committed {
  return {
    rows: drafts.flatMap((d) => {
      const spec = checkDraft(d).spec ?? d.saved
      return spec ? [{ id: d.id, spec }] : []
    }),
    at,
  }
}

/**
 * Settings > General > Snooze presets: the list every Snooze menu resolves,
 * stored on this desktop's backend, which the phones read too. A text field
 * saves when it loses focus and a choice when it is picked; a row that is not
 * valid keeps its last saved preset in the menu until it is fixed.
 */
export function SnoozePresetsPanel({ now = () => new Date() }: { now?: () => Date }) {
  const stored = useSnoozePresetsStore((s) => s.presets)
  const [drafts, setDrafts] = useState<PresetDraft[]>(() => draftsOf(stored))
  const [committed, setCommitted] = useState<Committed>(() => committedOf(drafts, now()))
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [undo, setUndo] = useState<{ draft: PresetDraft; index: number; name: string } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  /** The list this editor last sent or took, so its own broadcast is not taken as news. */
  const known = useRef(JSON.stringify(stored))
  const pendingSaves = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const nowRef = useRef(now)
  nowRef.current = now
  const focusNext = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const run = focusNext.current
    focusNext.current = null
    run?.()
  })

  // Another client wrote the list: take it unless this editor holds a change.
  useEffect(() => {
    const key = JSON.stringify(stored)
    if (key === known.current) return
    const holding = draftsRef.current.some((d) => d.dirty || !checkDraft(d).spec) || pendingSaves.current > 0
    if (holding) return
    known.current = key
    const next = draftsOf(stored)
    setDrafts(next)
    setCommitted(committedOf(next, nowRef.current()))
    setUndo(null)
  }, [stored])

  const say = (text: string) => setAnnouncement(text)
  const focusIn = (selector: string) => {
    focusNext.current = () => listRef.current?.querySelector<HTMLElement>(selector)?.focus()
  }

  /** The save boundary: the menu preview and the status line change here, and a changed list goes to the backend. */
  const commit = (next: PresetDraft[]) => {
    const saved = markSaved(next)
    setDrafts(saved)
    setCommitted(committedOf(saved, nowRef.current()))
    const list = listToSave(saved)
    const key = JSON.stringify(list)
    if (list.length === 0 || key === known.current) return
    known.current = key
    pendingSaves.current += 1
    setSave({ kind: 'saving' })
    window.api.app.setSnoozePresets(list).then(
      (result) => {
        pendingSaves.current -= 1
        if (result.ok) {
          useSnoozePresetsStore.getState().take(result.presets)
          if (pendingSaves.current === 0) setSave({ kind: 'idle' })
        } else {
          log.warn('the backend refused the presets', { reason: result.reason, index: result.index })
          known.current = ''
          setSave({ kind: 'failed', reason: presetListRefusalText(result.reason, result.index) })
        }
      },
      (err: unknown) => {
        pendingSaves.current -= 1
        log.warn('saving the presets failed', err)
        known.current = ''
        setSave({ kind: 'failed', reason: 'the backend did not answer' })
      },
    )
  }

  const update = (id: string, patch: Partial<PresetDraft>) =>
    setDrafts((rows) => rows.map((d) => (d.id === id ? { ...d, ...patch, dirty: true } : d)))

  const blur = (id: string, field: DraftField) => {
    const rows = draftsRef.current.map((d) =>
      d.id === id ? normalizeField({ ...d, touched: { ...d.touched, [field]: true } }, field) : d,
    )
    commit(rows)
  }

  const pick = (id: string, patch: Partial<PresetDraft>) =>
    commit(draftsRef.current.map((d) => (d.id === id ? { ...d, ...patch } : d)))

  const move = (index: number, by: -1 | 1) => {
    const rows = [...draftsRef.current]
    const to = index + by
    if (to < 0 || to >= rows.length) return
    const [row] = rows.splice(index, 1)
    rows.splice(to, 0, row)
    focusIn(`[data-row="${row.id}"] [data-action="${by < 0 ? 'up' : 'down'}"]`)
    say(`Moved ${draftName(row, to)} to position ${to + 1} of ${rows.length}.`)
    commit(rows)
  }

  const remove = (index: number) => {
    const rows = [...draftsRef.current]
    if (rows.length === 1) {
      say(LAST_ROW_REASON)
      return
    }
    const [row] = rows.splice(index, 1)
    const name = draftName(row, index)
    setUndo({ draft: row, index, name })
    const after = rows[index]
    if (after) focusIn(`[data-row="${after.id}"] [data-field="label"]`)
    else focusNext.current = () => addRef.current?.focus()
    say(`Removed ${name}. Undo is below the list.`)
    commit(rows)
  }

  const restore = () => {
    if (!undo) return
    const rows = [...draftsRef.current]
    rows.splice(Math.min(undo.index, rows.length), 0, undo.draft)
    setUndo(null)
    focusIn(`[data-row="${undo.draft.id}"] [data-field="label"]`)
    say(`Restored ${undo.name}.`)
    commit(rows)
  }

  const add = () => {
    if (draftsRef.current.length >= MAX_SNOOZE_PRESETS) {
      say(LIMIT_REASON)
      return
    }
    const row = blankDraft(newId())
    setUndo(null)
    setDrafts([...draftsRef.current, row])
    focusIn(`[data-row="${row.id}"] [data-field="label"]`)
    say(`Added preset ${draftsRef.current.length + 1}.`)
  }

  const reset = async () => {
    const count = draftsRef.current.length
    const ok = await confirm({
      title: 'Reset snooze presets?',
      body: resetBody(count),
      confirmLabel: 'Reset presets',
      destructive: true,
    })
    if (!ok) return
    setUndo(null)
    commit(draftsOf(DEFAULT_SNOOZE_PRESETS))
    say('Reset to the 4 default presets.')
  }

  const full = drafts.length >= MAX_SNOOZE_PRESETS
  const last = drafts.length === 1
  const status = statusLine(drafts, save)
  const rowStanding = new Map<string, PresetStanding>()
  const standingList = standings(
    committed.rows.map((r) => r.spec),
    committed.at,
  )
  committed.rows.forEach((r, i) => rowStanding.set(r.id, standingList[i]))
  const menu = committed.rows
    .map((r, i) => ({ label: r.spec.label, standing: standingList[i], id: r.id }))
    .filter((item) => item.standing.shown)
    .sort((a, b) => a.standing.at.getTime() - b.standing.at.getTime())
  const notInMenu = committed.rows.filter((_, i) => !standingList[i].shown)

  return (
    <div className="flex flex-col gap-[18px]">
      <section aria-labelledby="snooze-presets-title">
        <h3
          id="snooze-presets-title"
          className="mb-1 text-[11px] font-[600] uppercase tracking-[0.07em] text-[var(--text-muted)]"
        >
          Snooze presets
        </h3>
        <p className="mb-1 text-[12px] text-[var(--text-secondary)]">
          The times in the Snooze menu. You can have from 1 to {MAX_SNOOZE_PRESETS}.
        </p>
        <p className="mb-2.5 text-[12px] text-[var(--text-secondary)]">
          Your phones use these presets in their Snooze sheet. You can change them only here.
        </p>
        <div className="@container overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
          <div ref={listRef}>
            {drafts.map((draft, index) => (
              <PresetRow
                key={draft.id}
                draft={draft}
                index={index}
                count={drafts.length}
                at={committed.at}
                standing={rowStanding.get(draft.id)}
                onEdit={(patch) => update(draft.id, patch)}
                onBlur={(field) => blur(draft.id, field)}
                onPick={(patch) => pick(draft.id, patch)}
                onMove={(by) => move(index, by)}
                onRemove={() => remove(index)}
              />
            ))}
          </div>
          {undo && (
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-[14px] py-2 text-[12px]">
              <span className="min-w-0 flex-[1_1_160px] [overflow-wrap:anywhere]">Removed "{undo.name}".</span>
              <Button variant="outline" size="sm" onClick={restore}>
                Undo
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-[14px] py-2.5">
            <Button
              ref={addRef}
              variant="secondary"
              size="sm"
              aria-disabled={full}
              aria-describedby={full ? 'snooze-presets-limit' : undefined}
              onClick={add}
            >
              <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
                <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" fill="none" />
              </svg>
              Add preset
            </Button>
            <span className="text-[12px] text-[var(--text-secondary)] [font-variant-numeric:tabular-nums]">
              {drafts.length} of {MAX_SNOOZE_PRESETS}
            </span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => void reset()}>
              Reset to defaults
            </Button>
            {full && (
              <p id="snooze-presets-limit" className="m-0 basis-full text-[12px] text-[var(--text-secondary)]">
                {LIMIT_REASON}
              </p>
            )}
            {last && (
              <p id="snooze-presets-minimum" className="m-0 basis-full text-[12px] text-[var(--text-secondary)]">
                {LAST_ROW_REASON}
              </p>
            )}
          </div>
        </div>
        <p
          role="status"
          className={cn(
            'mt-2 mb-0 text-[12px]',
            status.bad ? 'text-[var(--text-error)]' : 'text-[var(--text-secondary)]',
          )}
        >
          {status.text}
        </p>
        <ul className="mt-2 mb-0 pl-4 text-[12px] text-[var(--text-secondary)]">
          <li>Each device uses its own local time when it opens the menu.</li>
          <li className="mt-0.5">
            If a clock change skips the time on that day, the time moves forward by the skipped amount (02:30 becomes
            03:30). If the time occurs two times, the first one is used.
          </li>
          <li className="mt-0.5">A day in a duration is 24 hours.</li>
        </ul>
      </section>
      <section aria-labelledby="snooze-preview-title">
        <h3
          id="snooze-preview-title"
          className="mb-1 text-[11px] font-[600] uppercase tracking-[0.07em] text-[var(--text-muted)]"
        >
          Menu preview
        </h3>
        <p className="mb-1 text-[12px] text-[var(--text-secondary)]">{previewAtText(committed.at)}</p>
        <p className="mb-2.5 text-[12px] text-[var(--text-secondary)]">
          The menu shows the soonest first, so the list order does not change it. Two presets that wake in the same
          minute show once: the one higher in the list wins. The preview changes when a change saves.
        </p>
        <div
          role="group"
          aria-labelledby="snooze-preview-title"
          data-testid="snooze-preview"
          className="w-[220px] max-w-full rounded-[8px] border border-border bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-md)]"
        >
          <div className="px-2 pt-1 pb-[5px] text-[11px] font-[500] text-[var(--text-secondary)]">Snooze until</div>
          {menu.length === 0 && <PreviewItem label="No preset shows now" />}
          {menu.map((item) => (
            <PreviewItem key={item.id} label={item.label} hint={menuHint(item.standing.at, committed.at)} />
          ))}
          <hr className="mx-0.5 my-1 border-0 border-t border-[var(--border)]" />
          <PreviewItem label="Until PR #n changes" />
          <PreviewItem label="Custom date and time..." />
        </div>
        {notInMenu.length > 0 && (
          <ul className="mt-2 mb-0 list-none p-0 text-[12px] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
            {notInMenu.map((r) => (
              <li key={r.id}>Not in the menu now: {r.spec.label}</li>
            ))}
          </ul>
        )}
      </section>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  )
}

function PreviewItem({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex h-[26px] items-center gap-2 rounded-[5px] px-2 text-[12px] text-[var(--text-primary)]">
      <span className="min-w-0 truncate">{label}</span>
      {hint && (
        <span className="ml-auto flex-none text-[11px] text-[var(--text-secondary)] [font-variant-numeric:tabular-nums]">
          {hint}
        </span>
      )}
    </div>
  )
}

function PresetRow({
  draft,
  index,
  count,
  at,
  standing,
  onEdit,
  onBlur,
  onPick,
  onMove,
  onRemove,
}: {
  draft: PresetDraft
  index: number
  count: number
  at: Date
  standing: PresetStanding | undefined
  onEdit: (patch: Partial<PresetDraft>) => void
  onBlur: (field: DraftField) => void
  onPick: (patch: Partial<PresetDraft>) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const name = draftName(draft, index)
  const errors = shownErrors(draft)
  const spec = checkDraft(draft).spec
  const notice = rowNotice(draft, standing)
  const errorId = (field: DraftField) => `${draft.id}-${field}-error`
  const fieldProps = (field: DraftField) => ({
    'data-field': field,
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] ? errorId(field) : undefined,
    onBlur: () => onBlur(field),
  })
  const first = index === 0
  const lastRow = index === count - 1
  const only = count === 1

  return (
    <div
      role="group"
      aria-label={name}
      data-row={draft.id}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-[var(--border)] px-[14px] py-3 first:border-t-0 @min-[600px]:grid-cols-[minmax(0,1fr)_auto_auto]"
    >
      <div className="col-span-2 min-w-0 @min-[600px]:col-span-1">
        <Input
          {...fieldProps('label')}
          value={draft.label}
          placeholder="Label, for example Tonight"
          aria-label={`Label of preset ${index + 1}`}
          onChange={(event) => onEdit({ label: event.target.value })}
        />
      </div>
      <div className="col-span-2 justify-self-start">
        <Segmented
          label={`Kind of ${name}`}
          options={KIND_OPTIONS}
          value={draft.kind}
          onChange={(kind) => onPick({ kind })}
        />
      </div>
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 @min-[600px]:col-span-1">
        {draft.kind === 'duration' ? (
          <>
            <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              For
              <Input
                {...fieldProps('amount')}
                className="w-16 [font-variant-numeric:tabular-nums]"
                inputMode="numeric"
                value={draft.amount}
                aria-label={`Duration of ${name}`}
                onChange={(event) => onEdit({ amount: event.target.value })}
              />
            </label>
            <Segmented
              label={`Unit of ${name}`}
              options={UNIT_OPTIONS}
              value={draft.unit}
              onChange={(unit) => onPick({ unit })}
            />
          </>
        ) : (
          <>
            {draft.kind === 'time' ? (
              <Segmented
                label={`Day of ${name}`}
                options={DAY_OPTIONS}
                value={String(draft.dayOffset) as '0' | '1'}
                onChange={(day) => onPick({ dayOffset: day === '1' ? 1 : 0 })}
              />
            ) : (
              <Segmented
                label={`Weekday of ${name}`}
                options={WEEKDAY_OPTIONS}
                value={String(draft.weekday)}
                onChange={(weekday) => onPick({ weekday: Number(weekday) })}
                itemClassName="min-w-[34px] px-[5px]"
              />
            )}
            <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              at
              <Input
                {...fieldProps('time')}
                className="w-[72px] [font-variant-numeric:tabular-nums]"
                inputMode="numeric"
                placeholder="HH:MM"
                value={draft.time}
                aria-label={`Time of ${name}`}
                onChange={(event) => onEdit({ time: event.target.value })}
              />
            </label>
          </>
        )}
      </div>
      <span className="justify-self-end text-[12px] text-[var(--text-secondary)] [font-variant-numeric:tabular-nums]">
        {spec && <NextText spec={spec} at={at} />}
      </span>
      <div className="flex justify-self-end gap-0.5">
        <IconButton
          action="up"
          label={`Move ${name} up`}
          disabled={first}
          onClick={() => onMove(-1)}
          path="M3.5 8.5L7 5l3.5 3.5"
        />
        <IconButton
          action="down"
          label={`Move ${name} down`}
          disabled={lastRow}
          onClick={() => onMove(1)}
          path="M3.5 5.5L7 9l3.5-3.5"
        />
        <IconButton
          action="remove"
          label={`Remove ${name}`}
          disabled={only}
          describedBy={only ? 'snooze-presets-minimum' : undefined}
          onClick={onRemove}
          path="M4 4l6 6M10 4l-6 6"
        />
      </div>
      {(Object.keys(errors).length > 0 || notice) && (
        <div className="col-span-2 flex min-w-0 flex-col gap-0.5 @min-[600px]:col-span-3">
          {(['label', 'time', 'amount'] as const).map(
            (field) =>
              errors[field] && (
                <Message key={field} id={errorId(field)} tone="error">
                  {errors[field]}
                </Message>
              ),
          )}
          {notice && <Message tone={notice.tone}>{notice.text}</Message>}
        </div>
      )}
    </div>
  )
}

function NextText({ spec, at }: { spec: SnoozePresetSpec; at: Date }) {
  const timing = presetTiming(spec, at)
  if (timing.hidden) return null
  const moved =
    spec.kind !== 'duration' && (timing.at.getHours() !== spec.hour || timing.at.getMinutes() !== spec.minute)
  return (
    <>
      Next: <b className="font-[500] text-[var(--text-primary)]">{whenText(timing.at, at)}</b>
      {moved &&
        ` (${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')} does not exist that day)`}
    </>
  )
}

function Message({ id, tone, children }: { id?: string; tone: 'plain' | 'error' | 'warn'; children: ReactNode }) {
  return (
    <p
      id={id}
      className={cn(
        'm-0 text-[12px] [overflow-wrap:anywhere]',
        tone === 'error'
          ? 'text-[var(--text-error)]'
          : tone === 'warn'
            ? 'text-[var(--text-warning)]'
            : 'text-[var(--text-secondary)]',
      )}
    >
      {children}
    </p>
  )
}

function IconButton({
  action,
  label,
  disabled,
  describedBy,
  onClick,
  path,
}: {
  action: string
  label: string
  disabled: boolean
  describedBy?: string
  onClick: () => void
  path: string
}) {
  return (
    <button
      type="button"
      data-action={action}
      aria-label={label}
      aria-disabled={disabled}
      aria-describedby={describedBy}
      onClick={() => {
        if (!disabled || action === 'remove') onClick()
      }}
      className={cn(
        'grid size-[26px] cursor-pointer place-items-center rounded-[6px] border-0 bg-transparent p-0 text-[var(--text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled ? 'cursor-default opacity-55' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <path
          d={path}
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

/**
 * A row of options as one radio group: one Tab stop on the checked option;
 * the arrows, Home and End move and select, and focus stays on the option.
 */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  itemClassName,
}: {
  label: string
  options: ReadonlyArray<{ value: T; label: string; name?: string }>
  value: T
  onChange: (value: T) => void
  itemClassName?: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length
    const keys: Record<string, number> = {
      ArrowRight: (i + 1) % n,
      ArrowDown: (i + 1) % n,
      ArrowLeft: (i - 1 + n) % n,
      ArrowUp: (i - 1 + n) % n,
      Home: 0,
      End: n - 1,
    }
    const to = keys[event.key]
    if (to === undefined) return
    event.preventDefault()
    refs.current[to]?.focus()
    if (options[to].value !== value) onChange(options[to].value)
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex flex-wrap gap-0.5 rounded-[7px] border border-border bg-[var(--bg-secondary)] p-0.5"
    >
      {options.map((option, i) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.name}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              if (!checked) onChange(option.value)
            }}
            onKeyDown={(event) => onKeyDown(event, i)}
            className={cn(
              'h-6 cursor-pointer whitespace-nowrap rounded-[5px] border-0 px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              checked
                ? 'bg-[var(--bg-tertiary)] font-[500] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--border)]'
                : 'bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              itemClassName,
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
