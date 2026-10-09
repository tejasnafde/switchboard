/**
 * The context chip that Cmd+L, @-mentions and "Ask the agent" put in the
 * composer, and that sent user bubbles draw for the same pills. One component
 * for both, so the chip never drifts between compose and sent views.
 *
 * Source icon, name, a hairline and a count, tinted per kind (`--chip-tint-*`
 * in global.css, darker in the light theme). A 300 ms hover (or Space on a
 * chip selected with the arrow keys) opens a card with the first lines of what
 * was captured; a click opens the source. The card never takes focus, so the
 * composer keeps its caret.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { DraftPillKind } from '../../../stores/draft-store'
import { Popover, PopoverAnchor, PopoverContent } from '../../ui/popover'
import { pillChipModel, splitChipName, type PillChipKind, type PillChipModel } from '../../../services/pill-chip-model'
import { openPillTarget } from '../../../services/pill-chip-open'

/** How long the pointer rests on a chip before its card opens. */
export const PILL_CARD_HOVER_MS = 300

// Plain joining, not tailwind-merge: it reads text-[12px] and text-[color-mix(...)]
// as one group and would drop the size.
const classes = (...parts: Array<string | false | undefined>): string => parts.filter(Boolean).join(' ')

const TINT_VAR: Record<PillChipKind, string> = {
  file: 'var(--chip-tint-file)',
  terminal: 'var(--chip-tint-terminal)',
  'chat-message': 'var(--chip-tint-chat)',
  you: 'var(--chip-tint-you)',
  review: 'var(--chip-tint-review)',
}

function KindIcon({ kind, className }: { kind: PillChipKind; className?: string }) {
  const common = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true, className: classes('h-[12px] w-[12px] shrink-0', className) }
  if (kind === 'file') return <svg {...common}><path d="M4 1.5h5l3 3v10H4z" /><path d="M9 1.5v3h3" /></svg>
  if (kind === 'terminal') return <svg {...common}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4.5 6l2 2-2 2M8 10.5h3.5" /></svg>
  if (kind === 'you') return <svg {...common}><circle cx="8" cy="5.5" r="2.5" /><path d="M3 14c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" /></svg>
  if (kind === 'review') return <svg {...common}><circle cx="4.5" cy="4" r="1.5" /><circle cx="4.5" cy="12" r="1.5" /><circle cx="11.5" cy="12" r="1.5" /><path d="M4.5 5.5v5M11.5 10.5V7a2 2 0 0 0-2-2H7" /></svg>
  return <svg {...common}><path d="M2 3.5h12v7H6l-3 2.5v-2.5H2z" /></svg>
}

const CHIP_CLASS = classes(
  'group relative mx-px inline-flex h-[18px] max-w-[min(220px,100%)] cursor-pointer items-center gap-[4px] rounded-[4px] pl-[5px] pr-px align-[-3px]',
  'whitespace-nowrap text-[12px] leading-[18px] [font-family:var(--font-sans)] [font-variant-numeric:tabular-nums]',
  'bg-[color-mix(in_srgb,var(--chip-tint)_12%,transparent)] text-[color-mix(in_srgb,var(--chip-tint)_70%,var(--text-primary))]',
  'shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--chip-tint)_20%,transparent)] transition-[background-color,box-shadow] duration-[120ms]',
  'hover:bg-[color-mix(in_srgb,var(--chip-tint)_20%,transparent)] hover:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--chip-tint)_40%,transparent)]',
  'data-[selected=true]:bg-[color-mix(in_srgb,var(--chip-tint)_26%,transparent)] data-[selected=true]:shadow-[inset_0_0_0_1.5px_var(--chip-tint)]',
  'data-[selected=true]:text-[color-mix(in_srgb,var(--chip-tint)_80%,var(--text-primary))]',
)

const REMOVE_CLASS = classes(
  '-ml-px grid h-[16px] w-[16px] shrink-0 cursor-pointer appearance-none place-items-center rounded-[3px] border-0 bg-transparent p-0 text-[inherit]',
  'opacity-[var(--chip-remove-opacity)] group-hover:opacity-90 group-data-[selected=true]:opacity-90',
  'hover:!opacity-100 hover:bg-[color-mix(in_srgb,var(--chip-tint)_24%,transparent)]',
)

function PillChipCard({ model, removable }: { model: PillChipModel; removable: boolean }) {
  const header = [model.source, model.detail].filter(Boolean).join(' · ')
  return (
    <>
      <div className="mb-[6px] flex items-center gap-[6px] text-[11.5px] text-[var(--text-secondary)]">
        <KindIcon kind={model.kind} className="text-[var(--chip-tint)]" />
        <b className="min-w-0 truncate font-semibold text-[var(--text-primary)]">{model.name}</b>
        <span className="shrink-0">{header}</span>
        {model.where && (
          <span className="ml-auto min-w-0 truncate text-[10.5px] text-[var(--text-muted)] [font-family:var(--font-mono)]">{model.where}</span>
        )}
      </div>
      {model.preview.length > 0 && (
        <pre className="m-0 overflow-hidden text-[11px] leading-[1.5] [font-family:var(--font-mono)]">
          {model.preview.map((line, i) => <div key={i} className="truncate whitespace-pre">{line || ' '}</div>)}
        </pre>
      )}
      {(model.target || removable || model.moreLines > 0) && (
        <div className="mt-[7px] flex items-center gap-[12px] border-0 border-t border-solid border-[var(--border)] pt-[6px] text-[10.5px] text-[var(--text-muted)]">
          {model.target && <span><kbd className="mr-[2px] rounded-[3px] bg-[var(--bg-tertiary)] px-[4px] text-[10px] text-[var(--text-secondary)] [font-family:var(--font-mono)]">{'↵'}</kbd> open</span>}
          {removable && <span><kbd className="mr-[2px] rounded-[3px] bg-[var(--bg-tertiary)] px-[4px] text-[10px] text-[var(--text-secondary)] [font-family:var(--font-mono)]">{'⌫'}</kbd> remove</span>}
          {model.moreLines > 0 && <span className="ml-auto">{model.moreLines === 1 ? '1 more line' : `${model.moreLines} more lines`}</span>}
        </div>
      )}
    </>
  )
}

interface PillChipVisualProps {
  label: string
  kind: DraftPillKind
  /** The text the pill expands to, when known: drives the count, the card and the open target. */
  content?: string | null
  /** Editor variant disables text selection; bubble variant allows copy. */
  selectable?: boolean
  /** Composer only: draws the remove control and calls this. */
  onRemove?: () => void
  /** Selected with the arrow keys in the composer. */
  selected?: boolean
  /** Controlled card state, for Space on a selected chip. Uncontrolled when absent. */
  cardOpen?: boolean
  onCardOpenChange?: (open: boolean) => void
  /** Forwarded to the root span (data attributes, contentEditable). */
  rootProps?: Record<string, string | boolean | undefined>
}

/** Open a chip's source from its DOM node; the chat it sits in names the session. */
export function openPillFromElement(model: PillChipModel, el: Element | null): boolean {
  if (!model.target) return false
  const sessionId = el?.closest('[data-session-id]')?.getAttribute('data-session-id') ?? null
  return openPillTarget(model.target, sessionId)
}

export function PillChipVisual({
  label,
  kind,
  content,
  selectable = true,
  onRemove,
  selected = false,
  cardOpen,
  onCardOpenChange,
  rootProps,
}: PillChipVisualProps): ReactNode {
  const model = useMemo(() => pillChipModel({ kind, label, content }), [kind, label, content])
  const { head, tail } = splitChipName(model.kind, model.name)
  const rootRef = useRef<HTMLSpanElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [hoverOpen, setHoverOpen] = useState(false)
  const open = cardOpen ?? hoverOpen
  const setOpen = (next: boolean): void => {
    if (onCardOpenChange) onCardOpenChange(next)
    else setHoverOpen(next)
  }
  const clearHover = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }
  useEffect(() => clearHover, [])

  const onRemoveTarget = (target: EventTarget | null): boolean =>
    target instanceof Element && !!target.closest('[data-pill-remove]')

  const tintStyle = { '--chip-tint': TINT_VAR[model.kind] } as CSSProperties
  const ariaLabel = [model.source, model.name, model.detail].filter(Boolean).join(', ')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          ref={rootRef}
          data-pill-chip="true"
          data-pill-kind={model.kind}
          data-pill-label={label}
          data-selected={selected || undefined}
          aria-label={ariaLabel}
          {...rootProps}
          className={classes(CHIP_CLASS, selectable ? 'select-text' : 'select-none')}
          style={tintStyle}
          // Over the chip body the card opens after a rest; over the cross it does not.
          onPointerOver={(e) => {
            if (onRemoveTarget(e.target)) clearHover()
            else if (!hoverTimer.current && !open) hoverTimer.current = setTimeout(() => setOpen(true), PILL_CARD_HOVER_MS)
          }}
          onPointerLeave={() => {
            clearHover()
            if (open) setOpen(false)
          }}
          // Keep the caret and focus where they are: a chip is not a tab stop.
          onMouseDown={(e) => { if (!selectable) e.preventDefault() }}
          onClick={(e) => {
            if (onRemoveTarget(e.target)) return
            clearHover()
            if (model.target) {
              setOpen(false)
              openPillFromElement(model, rootRef.current)
            }
          }}
        >
          <KindIcon kind={model.kind} />
          <span className="inline-flex min-w-0 font-medium tracking-[-0.005em]">
            <span className="min-w-0 overflow-hidden text-ellipsis">{head}</span>
            {tail && <span className="shrink-0">{tail}</span>}
          </span>
          {model.count && (
            <>
              <span aria-hidden className="h-[10px] w-px shrink-0 bg-[color-mix(in_srgb,var(--chip-tint)_32%,transparent)]" />
              <span className="shrink-0 text-[11px] text-[color-mix(in_srgb,var(--chip-tint)_55%,var(--text-secondary))] [.theme-light_&]:text-[color-mix(in_srgb,var(--chip-tint)_75%,var(--text-primary))]">
                {model.count}
              </span>
            </>
          )}
          {onRemove && (
            <button
              type="button"
              data-pill-remove="true"
              aria-label={`Remove ${model.source.toLowerCase()} ${model.name}`}
              className={REMOVE_CLASS}
              // Prevent focus stealing: clicking the cross must leave the caret in the composer.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); clearHover(); setOpen(false); onRemove() }}
            >
              <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={1.75} aria-hidden className="h-[8px] w-[8px]">
                <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" />
              </svg>
            </button>
          )}
        </span>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={5}
        role="tooltip"
        aria-label={`${model.source}: ${model.name}`}
        // A preview, not a dialog: focus and the caret stay in the composer.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="sb-floating-surface pointer-events-none z-[1200] w-[320px] max-w-[calc(100vw-16px)] rounded-[8px] border border-solid border-[var(--border)] px-[10px] pb-[7px] pt-[8px] text-left text-[var(--text-primary)] [font-family:var(--font-sans)]"
        style={tintStyle}
      >
        <PillChipCard model={model} removable={!!onRemove} />
      </PopoverContent>
    </Popover>
  )
}
