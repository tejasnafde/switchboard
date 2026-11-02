/**
 * The Snooze menu of a Recents row: the presets resolved when the menu opens,
 * each with its wake time on the right, and "Until PR #n changes" when the
 * chat links an open PR. The overflow form of a narrow row adds its other
 * actions (Settle) under a separator. `ui/menu` owns the keys: arrows, Home,
 * End, Enter, and Escape back to the button.
 */
import { useRef, useState, type ReactNode } from 'react'
import { resolvePresets, wakeLabel, type PresetOption } from '@shared/chat-snooze'
import type { SnoozeChoice } from '../../services/chat-inbox'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../ui/menu'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('sidebar:snooze-menu')

/** A linked open PR the chat can wait on. */
export interface SnoozePrChoice {
  key: string
  number: number
}

export interface SnoozeMenuExtra {
  label: string
  onSelect: () => void
}

export function SnoozeMenu({
  label,
  className,
  children,
  loadPr,
  extras = [],
  onPick,
  onPicked,
  now = () => new Date(),
}: {
  /** The trigger's accessible name. */
  label: string
  className: string
  children: ReactNode
  loadPr?: () => Promise<SnoozePrChoice | null>
  extras?: readonly SnoozeMenuExtra[]
  onPick: (choice: SnoozeChoice) => void
  /** After any item ran, in place of focus going back to the trigger. */
  onPicked?: () => void
  now?: () => Date
}) {
  const [open, setOpen] = useState(false)
  const [shownAt, setShownAt] = useState(() => now())
  const [options, setOptions] = useState<PresetOption[]>([])
  const [pr, setPr] = useState<SnoozePrChoice | null>(null)
  const picked = useRef(false)
  /** Counts menu opens, so a PR read from an earlier open never replaces a later one. */
  const opens = useRef(0)

  const openChange = (next: boolean) => {
    if (next) {
      // The menu keeps these instants until it closes: a clock-time item sends what it showed.
      const at = now()
      setShownAt(at)
      setOptions(resolvePresets(at))
      setPr(null)
      picked.current = false
      const open = ++opens.current
      loadPr?.().then(
        (found) => {
          if (open === opens.current) setPr(found)
        },
        (err: unknown) => log.warn('reading the linked PRs failed', err),
      )
    }
    setOpen(next)
  }

  const run = (action: () => void) => {
    picked.current = true
    setOpen(false)
    action()
  }

  return (
    <Menu open={open} onOpenChange={openChange}>
      <MenuTrigger asChild>
        <button
          type="button"
          className={className}
          aria-label={label}
          aria-haspopup="menu"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && !open) {
              event.preventDefault()
              openChange(true)
            }
          }}
        >
          {children}
        </button>
      </MenuTrigger>
      <MenuContent
        aria-label="Snooze until"
        className="w-[212px]"
        onCloseAutoFocus={(event) => {
          if (!picked.current) return
          event.preventDefault()
          onPicked?.()
        }}
      >
        <MenuLabel>Snooze until</MenuLabel>
        {options.map((option) => (
          <MenuItem
            key={option.label}
            trailing={wakeLabel(option.at, null, shownAt)}
            onClick={() => run(() => onPick({ option }))}
          >
            {option.label}
          </MenuItem>
        ))}
        {pr && (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => run(() => onPick({ pr: pr.key }))}>Until PR #{pr.number} changes</MenuItem>
          </>
        )}
        {extras.length > 0 && <MenuSeparator />}
        {extras.map((extra) => (
          <MenuItem key={extra.label} onClick={() => run(extra.onSelect)}>
            {extra.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
