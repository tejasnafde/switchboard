import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FEATURE_TOUR_STEPS } from './onboarding/feature-registry'
import type { UpdateStatus } from '@shared/update-status'
import { updateRowView, updateStatusLabel } from './settings/update-row-model'
import { updateFooterCopy } from './settings/update-footer-copy'
import { fireTestNotification, currentNotificationPermission } from '../services/notifications'
import {
  formatDiagnosticsReport,
  formatMb,
  sortProcessesByMemory,
  diagnosticsAppFootprintMb,
  diagnosticsGist,
  diagnosticsDefaultExpanded,
  DIAGNOSTICS_EXPANDED_SETTING_KEY,
} from '@shared/diagnostics-report'
import type { DiagnosticsSnapshot } from '@shared/diagnostics-report'
import { createRendererLogger } from '../logger'
import { AccountsPanel } from './settings/AccountsPanel'
import { MobilePairingTab } from './settings/MobilePairingTab'
import { LaunchConfigsPanel } from './settings/LaunchConfigsPanel'
import { ArchiveDataPage } from './settings/ArchiveDataPage'
import { WorktreeProtectionPanel } from './settings/WorktreeProtectionPanel'
import { useSettingValues, type SettingValues } from './settings/setting-values'
import {
  SETTINGS_PAGES,
  SETTING_ROW,
  SETTING_ROWS,
  PRIVACY_POLICY_URL,
  changedCountByPage,
  defaultValueLabel,
  isSettingChanged,
  pageTitle,
  searchSettingRows,
  type SettingRowDef,
  type SettingsPageId,
} from './settings/settings-rows'
import { RECENT_SESSION_LIMITS } from './sidebar/recent-session-limit'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { onEscapeFirst } from './ui/escape-first'
import { cn } from '../lib/utils'

const log = createRendererLogger('component:settings')

interface SettingsPageProps {
  /** The page to show; null closes Settings. */
  page: SettingsPageId | null
  onNavigate: (page: SettingsPageId) => void
  onClose: () => void
}

interface SettingsContextValue extends SettingValues {
  highlight: string | null
}

const SettingsContext = createContext<SettingsContextValue>({ values: {}, set: () => {}, highlight: null })

/**
 * Settings as a full-window page: navigation and search on the left, one
 * page on the right. Still a Radix dialog underneath, for the focus trap,
 * Escape and returning focus to wherever it was on open.
 */
export function SettingsPage({ page, onNavigate, onClose }: SettingsPageProps) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (page !== null) return
    setQuery('')
    setHighlight(null)
  }, [page])

  const navigate = useCallback((next: SettingsPageId, rowId: string | null = null) => {
    setQuery('')
    setHighlight(rowId)
    onNavigate(next)
  }, [onNavigate])

  return (
    <Dialog open={page !== null} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
        // Escape clears a search before it closes Settings.
        onEscapeKeyDown={(event) => {
          if (!query) return
          event.preventDefault()
          setQuery('')
        }}
        overlayClassName="z-[1000] top-[var(--titlebar-height)] bg-transparent"
        className="settings-page inset-x-0 bottom-0 top-[var(--titlebar-height)] z-[1000] flex text-[var(--text-primary)]"
      >
        {page !== null && (
          <SettingsBody
            page={page}
            query={query}
            onQuery={setQuery}
            highlight={highlight}
            searchRef={searchRef}
            onNavigate={navigate}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SettingsBody({
  page, query, onQuery, highlight, searchRef, onNavigate, onClose,
}: {
  page: SettingsPageId
  query: string
  onQuery: (query: string) => void
  highlight: string | null
  searchRef: React.RefObject<HTMLInputElement | null>
  onNavigate: (page: SettingsPageId, rowId?: string | null) => void
  onClose: () => void
}) {
  const settingValues = useSettingValues()
  const changed = useMemo(() => changedCountByPage(settingValues.values), [settingValues.values])
  const results = useMemo(() => searchSettingRows(query), [query])
  const searching = query.trim() !== ''
  const context = useMemo(() => ({ ...settingValues, highlight }), [settingValues, highlight])

  return (
    <SettingsContext.Provider value={context}>
      <nav aria-label="Settings pages" className="flex w-[212px] shrink-0 flex-col gap-[2px] border-r border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-3">
        <Button variant="ghost" size="sm" onClick={onClose} className="mb-1 self-start font-[500] text-[var(--text-secondary)]">
          <ChevronLeftIcon />
          Back
        </Button>
        <DialogTitle className="px-2.5 pb-2 text-[15px] font-[600]">Settings</DialogTitle>
        <input
          ref={searchRef}
          type="search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !results[0]) return
            // Focus moves to the opened row's control during this keydown; left
            // alone, the same key press would then activate that control.
            event.preventDefault()
            onNavigate(results[0].page, results[0].id)
          }}
          className="mx-[2px] mb-2.5 rounded-[7px] border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus-visible:border-[var(--border-focus)]"
        />
        {SETTINGS_PAGES.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-current={!searching && p.id === page ? 'page' : undefined}
            onClick={() => onNavigate(p.id)}
            className={cn(
              'flex cursor-pointer items-center justify-between gap-2 rounded-[6px] border-0 px-2.5 py-1.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
              !searching && p.id === page
                ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
            )}
          >
            <span>{p.title}</span>
            {changed[p.id] > 0 && (
              <span className="text-[10.5px] text-[var(--text-muted)]">{changed[p.id]} changed</span>
            )}
          </button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto bg-[var(--bg-primary)] px-[30px] py-[22px]">
        <div className="max-w-[760px]">
          {searching
            ? <SearchResults query={query} results={results} onOpen={(row) => onNavigate(row.page, row.id)} />
            : <SettingsPageBody page={page} onNavigate={onNavigate} />}
        </div>
      </main>
    </SettingsContext.Provider>
  )
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
      <path d="M7.5 2.5 L4 6 L7.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SearchResults({ query, results, onOpen }: { query: string; results: SettingRowDef[]; onOpen: (row: SettingRowDef) => void }) {
  const trimmed = query.trim()
  return (
    <>
      <h2 className="mb-1 text-[18px] font-[600]">
        {results.length} result{results.length === 1 ? '' : 's'} for "{trimmed}"
      </h2>
      <p className="mb-[18px] text-[13px] text-[var(--text-secondary)]">Every page is searched.</p>
      <SettingsCard>
        {results.length === 0 ? (
          <div className="px-[14px] py-3 text-[12.5px] text-[var(--text-secondary)]">No setting matches.</div>
        ) : results.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => onOpen(row)}
            className="flex w-full cursor-pointer items-center gap-4 border-0 border-t border-solid border-t-[var(--border)] bg-transparent px-[14px] py-2.5 text-left text-[var(--text-primary)] outline-none first:border-t-0 hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[11.5px] text-[var(--text-muted)]">{pageTitle(row.page)} · {row.section}</span>
              <span className="block text-[13px] font-[500]"><Highlighted text={row.label} query={trimmed} /></span>
              {row.description && (
                <span className="mt-0.5 block truncate text-[12px] text-[var(--text-secondary)]">{row.description}</span>
              )}
            </span>
            {row.keys && <Kbd>{row.keys}</Kbd>}
            <span className="shrink-0 text-[11.5px] text-[var(--text-muted)]">Open</span>
          </button>
        ))}
      </SettingsCard>
    </>
  )
}

/** Marks each query term where it appears in `text`. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return <>{text}</>
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig')
  return (
    <>
      {text.split(pattern).map((part, i) => (
        i % 2 === 1
          ? <mark key={i} className="rounded-[2px] bg-[var(--accent-subtle)] text-inherit">{part}</mark>
          : <span key={i}>{part}</span>
      ))}
    </>
  )
}

export function SettingsPageBody({ page, onNavigate }: { page: SettingsPageId; onNavigate?: (page: SettingsPageId) => void }) {
  const meta = SETTINGS_PAGES.find((p) => p.id === page)!
  if (page === 'data') {
    return <ArchiveDataPage meta={meta} Anchor={SettingAnchor} onOpenProjects={onNavigate && (() => onNavigate('projects'))} />
  }
  return (
    <>
      <h2 className="mb-1 text-[18px] font-[600]">{meta.title}</h2>
      <p className="mb-[18px] text-[13px] text-[var(--text-secondary)]">{meta.description}</p>
      {page === 'general' && <GeneralPage />}
      {page === 'appearance' && <AppearancePage />}
      {page === 'chat' && <ChatPage />}
      {page === 'accounts' && <AccountsPanel Anchor={SettingAnchor} />}
      {page === 'projects' && (
        <>
          <Section title={SETTING_ROW.launchConfigs.section}>
            <SettingAnchor def={SETTING_ROW.launchConfigs}><LaunchConfigsPanel /></SettingAnchor>
          </Section>
          <Section title={SETTING_ROW.worktreeProtection.section}>
            <SettingAnchor def={SETTING_ROW.worktreeProtection}><WorktreeProtectionPanel /></SettingAnchor>
          </Section>
        </>
      )}
      {page === 'keyboard' && <KeyboardPage />}
      {page === 'devices' && (
        <Section title={SETTING_ROW.mobile.section}>
          <SettingAnchor def={SETTING_ROW.mobile}><MobilePairingTab /></SettingAnchor>
        </Section>
      )}
      {page === 'about' && <AboutPage />}
    </>
  )
}

function GeneralPage() {
  return (
    <>
      <Section title="Notifications" card>
        <NotificationRows />
      </Section>
      <Section title="Updates" card>
        <SettingRow def={SETTING_ROW.updates} below={<div className="mt-2"><UpdateCheckRow /></div>} />
      </Section>
      <Section title="Sidebar" card>
        <SettingRow def={SETTING_ROW.recentLimit}>
          <SelectControl
            def={SETTING_ROW.recentLimit}
            options={RECENT_SESSION_LIMITS.map((n) => ({ value: String(n), label: `${n} conversations` }))}
          />
        </SettingRow>
      </Section>
      <Section title="Embedded IDE" card>
        <SettingRow def={SETTING_ROW.ideIdleTtl}>
          <IdleMinutesControl />
        </SettingRow>
      </Section>
      <Section title="Privacy" card>
        <SettingRow
          def={SETTING_ROW.analytics}
          extra={<a href={PRIVACY_POLICY_URL} className="text-[var(--accent)] no-underline hover:underline">Read the privacy policy</a>}
        >
          <ToggleControl def={SETTING_ROW.analytics} />
        </SettingRow>
      </Section>
    </>
  )
}

function AppearancePage() {
  return (
    <Section title="Theme" card>
      <SettingRow def={SETTING_ROW.theme}>
        <SegmentedControl
          def={SETTING_ROW.theme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'translucent', label: 'Translucent' },
            { value: 'system', label: 'System' },
          ]}
        />
      </SettingRow>
    </Section>
  )
}

function ChatPage() {
  return (
    <>
      <Section title="While the agent works" card>
        <SettingRow def={SETTING_ROW.followUp}>
          <SegmentedControl def={SETTING_ROW.followUp} options={[{ value: 'steer', label: 'Steer' }, { value: 'queue', label: 'Queue' }]} />
        </SettingRow>
        <SettingRow def={SETTING_ROW.streaming}>
          <ToggleControl def={SETTING_ROW.streaming} />
        </SettingRow>
      </Section>
      <Section title="Defaults for new chats" card>
        <SettingRow def={SETTING_ROW.envMode}>
          <SelectControl
            def={SETTING_ROW.envMode}
            options={[{ value: 'local', label: 'Local (project root)' }, { value: 'worktree', label: 'New worktree' }]}
          />
        </SettingRow>
      </Section>
      <Section title="In the chat" card>
        <SettingRow def={SETTING_ROW.fileDiffs}>
          <ToggleControl def={SETTING_ROW.fileDiffs} />
        </SettingRow>
      </Section>
    </>
  )
}

function KeyboardPage() {
  const rows = SETTING_ROWS.filter((row) => row.page === 'keyboard')
  const groups = [...new Set(rows.map((row) => row.section))]
  return (
    <>
      {groups.map((group) => (
        <Section key={group} title={group} card>
          {rows.filter((row) => row.section === group).map((def) => (
            <SettingRow key={def.id} def={def}>
              <Kbd>{def.keys}</Kbd>
            </SettingRow>
          ))}
        </Section>
      ))}
    </>
  )
}

function AboutPage() {
  return (
    <>
      <Section title="Switchboard" card>
        <SettingRow def={SETTING_ROW.about} />
      </Section>
      <Section title="Feature tour" card>
        <TourRows />
      </Section>
      <SettingAnchor def={SETTING_ROW.diagnostics}>
        <DiagnosticsSection />
      </SettingAnchor>
    </>
  )
}

function Section({ title, card = false, children }: { title: string; card?: boolean; children: ReactNode }) {
  return (
    <section className="mb-[18px]">
      <h3 className="mb-2 text-[11px] font-[600] uppercase tracking-[0.07em] text-[var(--text-muted)]">{title}</h3>
      {card ? <SettingsCard>{children}</SettingsCard> : children}
    </section>
  )
}

function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">{children}</div>
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="shrink-0 whitespace-nowrap rounded-[5px] border border-b-2 border-[var(--border)] bg-[var(--bg-tertiary)] px-1.5 py-[1px] [font-family:var(--font-mono)] text-[11.5px] text-[var(--text-secondary)]">
      {children}
    </kbd>
  )
}

const labelId = (id: string) => `setting-label-${id.replace(/\W/g, '-')}`

/**
 * Scrolls a row opened from search into view and moves focus to its first
 * control (never its Reset, where Enter would undo the setting), so the result the keyboard was on does not leave focus on nothing.
 */
function useHighlightTarget(id: string) {
  const { highlight } = useContext(SettingsContext)
  const ref = useRef<HTMLDivElement>(null)
  const active = highlight === id
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    el.scrollIntoView({ block: 'center' })
    const control = el.querySelector<HTMLElement>(':is(button, input, select, textarea, a[href]):not([data-setting-reset])')
    ;(control ?? el).focus({ preventScroll: true })
  }, [active])
  return { ref, active }
}

/** A whole panel (Providers, Mobile pairing...) as one searchable target. */
function SettingAnchor({ def, children }: { def: SettingRowDef; children: ReactNode }) {
  const { ref, active } = useHighlightTarget(def.id)
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-setting-row={def.id}
      className={cn('rounded-[10px] outline-none', active && 'ring-2 ring-[var(--border-focus)] ring-offset-4 ring-offset-[var(--bg-primary)]')}
    >
      {children}
    </div>
  )
}

/**
 * One row: label and description from its definition, a muted "Changed"
 * after the label and a Reset beside the control once its value differs from
 * the default, and the control.
 */
function SettingRow({ def, extra, below, children }: {
  def: SettingRowDef
  /** Shown after the description, e.g. a link or a live status. */
  extra?: ReactNode
  /** A block under the text, for rows whose control is more than one widget. */
  below?: ReactNode
  children?: ReactNode
}) {
  const { values, set } = useContext(SettingsContext)
  const { ref, active } = useHighlightTarget(def.id)
  const changed = isSettingChanged(def, values)
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-setting-row={def.id}
      data-changed={changed || undefined}
      className={cn(
        'flex items-center gap-4 border-t border-[var(--border)] px-[14px] py-3 outline-none first:border-t-0',
        active && 'bg-[var(--accent-subtle)]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline">
          <div id={labelId(def.id)} className="text-[13px] font-[500]">{def.label}</div>
          {changed && (
            <span
              title={`Changed from the default (${defaultValueLabel(def)})`}
              className="ml-2 inline-flex shrink-0 cursor-default items-center gap-[5px] text-[11px] font-[500] tracking-[0.02em] text-[var(--text-muted)]"
            >
              <span aria-hidden="true" className="size-[5px] rounded-full bg-[var(--text-secondary)]" />
              Changed
            </span>
          )}
        </div>
        {(def.description || extra) && (
          <div className="mt-0.5 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
            {def.description}{def.description && extra ? ' ' : null}{extra}
          </div>
        )}
        {below}
      </div>
      {changed && def.defaultValue !== undefined && (
        <button
          type="button"
          data-setting-reset
          aria-label={`Reset ${def.label}`}
          onClick={() => set(def.id, def.defaultValue!)}
          className="shrink-0 cursor-pointer rounded-[4px] border-0 bg-transparent px-1 text-[11.5px] text-[var(--text-muted)] outline-none hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-ring"
        >
          Reset
        </button>
      )}
      {children}
    </div>
  )
}

function useRowValue(def: SettingRowDef): [string | undefined, (value: string) => void] {
  const { values, set } = useContext(SettingsContext)
  return [values[def.id], useCallback((value: string) => set(def.id, value), [set, def.id])]
}

function ToggleControl({ def, onToggle }: { def: SettingRowDef; onToggle?: (on: boolean) => void }) {
  const [value, setValue] = useRowValue(def)
  const on = value === 'true'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelId(def.id)}
      disabled={value === undefined}
      onClick={() => { setValue(String(!on)); onToggle?.(!on) }}
      className={cn(
        'relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full border-0 p-0 outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
        on ? 'bg-[var(--accent)]' : 'bg-[rgba(128,128,128,0.35)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-[2px] top-[2px] size-[14px] rounded-full bg-[#fff] shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-100',
          on && 'translate-x-[14px]',
        )}
      />
    </button>
  )
}

function SelectControl({ def, options }: { def: SettingRowDef; options: Array<{ value: string; label: string }> }) {
  const [value, setValue] = useRowValue(def)
  return (
    <select
      aria-label={def.label}
      value={value ?? def.defaultValue}
      disabled={value === undefined}
      onChange={(event) => setValue(event.target.value)}
      className="shrink-0 cursor-pointer rounded-[6px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function SegmentedControl({ def, options }: { def: SettingRowDef; options: Array<{ value: string; label: string }> }) {
  const [value, setValue] = useRowValue(def)
  return (
    <div role="group" aria-labelledby={labelId(def.id)} className="inline-flex shrink-0 overflow-hidden rounded-[6px] border border-[var(--border)]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => setValue(o.value)}
          className={cn(
            'cursor-pointer border-0 border-l border-solid border-l-[var(--border)] px-2.5 py-[3px] text-[12px] outline-none first:border-l-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            value === o.value ? 'bg-[var(--bg-active)] text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Holds what was typed; the binding stores it only when it is a positive number. */
function IdleMinutesControl() {
  const def = SETTING_ROW.ideIdleTtl
  const [value, setValue] = useRowValue(def)
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <input
        type="number"
        min={1}
        step={1}
        aria-label={def.label}
        value={value ?? ''}
        onChange={(event) => setValue(event.target.value)}
        className="w-20 rounded-[6px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="text-[11px] text-[var(--text-muted)]">minutes</span>
    </span>
  )
}

/**
 * Notifications: the turn-finished toggle, which asks macOS for permission
 * when it is switched on, and a test send that reports the permission state.
 */
function NotificationRows() {
  const [enabled] = useRowValue(SETTING_ROW.notifyTurnEnd)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => currentNotificationPermission())
  const [testResult, setTestResult] = useState<string | null>(null)

  const onToggle = async (next: boolean) => {
    if (!next || typeof Notification === 'undefined' || Notification.permission !== 'default') return
    try {
      await Notification.requestPermission()
    } catch (err) {
      log.debug('Notification.requestPermission failed', err)
    }
    setPermission(currentNotificationPermission())
  }

  const test = async () => {
    setTestResult('Firing…')
    const r = await fireTestNotification()
    setPermission(currentNotificationPermission())
    setTestResult(r.ok ? 'Sent - check Notification Center.' : (r.reason ?? 'Failed.'))
    setTimeout(() => setTestResult(null), 6000)
  }

  const permissionBadge = permission === 'granted'
    ? { text: 'Permission: granted', className: 'text-[var(--text-muted)]' }
    : permission === 'denied'
      ? { text: 'Permission: denied (fix in macOS Settings)', className: 'text-[var(--error)]' }
      : permission === 'default'
        ? { text: 'Permission: not requested yet', className: 'text-[var(--warning)]' }
        : { text: 'Notification API unavailable', className: 'text-[var(--text-muted)]' }

  return (
    <>
      <SettingRow def={SETTING_ROW.notifyTurnEnd}>
        <ToggleControl def={SETTING_ROW.notifyTurnEnd} onToggle={(next) => void onToggle(next)} />
      </SettingRow>
      <SettingRow
        def={SETTING_ROW.notifyTest}
        below={(
          <div className="mt-1 text-[11.5px]">
            <span className={permissionBadge.className}>{permissionBadge.text}</span>
            {testResult && <span className="ml-2 text-[var(--text-muted)]">{testResult}</span>}
          </div>
        )}
      >
        <Button variant="outline" size="sm" onClick={test} disabled={enabled === 'false'}>Send test</Button>
      </SettingRow>
    </>
  )
}

/**
 * About > Feature tour. Replaying uses a window-level CustomEvent
 * (`tour:replay`) so App, which owns the tour modal, opens it at the
 * requested step and closes Settings.
 */
function TourRows() {
  const replay = (startAt = 0) => {
    window.dispatchEvent(new CustomEvent('tour:replay', { detail: { startAt } }))
  }
  return (
    <>
      <SettingRow def={SETTING_ROW.tourReplay}>
        <Button size="sm" onClick={() => replay(0)}>Replay tour</Button>
      </SettingRow>
      <SettingRow def={SETTING_ROW.tourAutoplay}>
        <ToggleControl def={SETTING_ROW.tourAutoplay} />
      </SettingRow>
      <SettingRow
        def={SETTING_ROW.tourSteps}
        below={(
          <div className="mt-2 flex flex-col gap-1">
            {FEATURE_TOUR_STEPS.map((step, i) => (
              <button
                key={step.id}
                type="button"
                onClick={() => replay(i)}
                className="flex cursor-pointer items-baseline gap-3 rounded-[5px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 py-2 text-left text-[var(--text-primary)] outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-5 [font-family:var(--font-mono)] text-[11px] text-[var(--text-muted)]">{String(i + 1).padStart(2, '0')}</span>
                <span className="text-[12.5px] font-[500]">{step.title}</span>
                <span className="ml-auto text-[11px] text-[var(--text-muted)]">Play</span>
              </button>
            ))}
          </div>
        )}
      />
    </>
  )
}

/**
 * About > Diagnostics, behind a disclosure.
 *
 * Collapsed by default: this page is opened to read a version number far more
 * often than to debug a slow machine. Three things keep the fold honest.
 *
 *   - The collapsed row carries a GIST (chip, live terminals, footprint), so
 *     it previews its own contents instead of being a blind door.
 *   - The snapshot still loads on MOUNT, not on expand. Collecting on click
 *     would put a visible "Collecting..." delay on an interaction that should
 *     feel instant, and it costs one call either way.
 *   - A translated build forces the section open. That is the one diagnostic
 *     here that is a call to action rather than a fact: an x64 build on Apple
 *     silicon is slow for a reason the user can fix.
 *
 * `diagnosticsGist` and `diagnosticsDefaultExpanded` hold those rules and are
 * unit-tested in `tests/unit/diagnostics-disclosure.test.ts`.
 */
const DIAGNOSTICS_TOP_PROCESSES = 6

export function DiagnosticsSection() {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [storedPreference, setStoredPreference] = useState<string | null>(null)
  /**
   * `storedPreference` is null both before the read finishes and when there is
   * no preference, so the default cannot be derived until this is true. A
   * translated build whose snapshot arrived first would otherwise open, then
   * shut again when the persisted "false" landed.
   */
  const [preferenceLoaded, setPreferenceLoaded] = useState(false)
  /** Once the user has an opinion this session, stop re-deriving the default. */
  const userToggled = useRef(false)
  const headerRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const bodyId = 'sb-diagnostics-body'

  useEffect(() => {
    let cancelled = false
    window.api.app.getDiagnostics()
      .then((value) => { if (!cancelled) setSnapshot(value) })
      .catch((err) => {
        log.warn('getDiagnostics failed', err)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.settings.get(DIAGNOSTICS_EXPANDED_SETTING_KEY)
      .then((value) => {
        if (cancelled) return
        setStoredPreference(typeof value === 'string' ? value : null)
        setPreferenceLoaded(true)
      })
      .catch((err) => {
        log.warn('diagnostics preference read failed', err)
        // A failed read is an answer too: "no preference". Without this the
        // section would never derive a default at all.
        if (!cancelled) setPreferenceLoaded(true)
      })
    return () => { cancelled = true }
  }, [])

  // The default depends on two async loads, so it is derived rather than set
  // once - the snapshot can arrive after the preference and flip `translated`.
  useEffect(() => {
    if (userToggled.current || !preferenceLoaded) return
    setExpanded(diagnosticsDefaultExpanded(snapshot, storedPreference))
  }, [snapshot, storedPreference, preferenceLoaded])

  const toggle = () => {
    userToggled.current = true
    const next = !expanded
    // Collapsing marks the body `inert`, and the spec then blurs whatever was
    // focused inside it straight to the document root. A keyboard user would
    // lose their place with no indication of where focus went, so bring it
    // back to the control they just operated.
    if (!next && bodyRef.current?.contains(document.activeElement)) {
      headerRef.current?.focus()
    }
    setExpanded(next)
    window.api.settings.set(DIAGNOSTICS_EXPANDED_SETTING_KEY, String(next))
      .catch((err) => log.warn('diagnostics preference write failed', err))
  }

  const flash = (text: string) => {
    setFeedback(text)
    setTimeout(() => setFeedback(null), 4000)
  }

  const copy = async () => {
    if (!snapshot) return
    try {
      await navigator.clipboard.writeText(formatDiagnosticsReport(snapshot))
      flash('Copied.')
    } catch (err) {
      log.warn('clipboard write failed', err)
      flash('Copy failed.')
    }
  }

  const openLogs = async () => {
    try {
      const r = await window.api.app.openLogsFolder()
      if (!r.ok) flash(r.error ?? 'Could not open the logs folder.')
    } catch (err) {
      log.warn('openLogsFolder failed', err)
      flash('Could not open the logs folder.')
    }
  }

  const buttonStyle: React.CSSProperties = {
    padding: '5px 12px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: '5px',
    color: 'var(--text-primary)',
    fontSize: '12px',
    cursor: 'pointer',
  }

  const gist = error
    ? 'unavailable'
    : snapshot
      ? diagnosticsGist(snapshot)
      : 'Collecting...'

  return (
    <div style={{ marginBottom: '20px' }}>
      <button
        ref={headerRef}
        type="button"
        className="sb-disclosure-header"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: 'calc(100% + 16px)',
          margin: '0 -8px',
          padding: '6px 8px',
          border: 'none',
          borderRadius: 'var(--radius)',
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
          color: 'var(--text-primary)',
        }}
      >
        <svg
          className="sb-disclosure-chevron"
          viewBox="0 0 12 12"
          width="12"
          height="12"
          fill="none"
          aria-hidden="true"
          style={{
            flex: 'none',
            color: 'var(--text-muted)',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 160ms cubic-bezier(0.2, 0.7, 0.3, 1)',
          }}
        >
          <path d="M4.5 2.5 L8 6 L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{
          fontSize: '11px',
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}>
          Diagnostics
        </span>
        <span style={{
          marginLeft: 'auto',
          fontSize: '11px',
          color: error
            ? 'var(--error)'
            : snapshot?.translated ? 'var(--warning)' : 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {gist}
        </span>
      </button>

      {/* `0fr` to `1fr` animates to the content's own height, so a longer
          process list cannot outgrow a hardcoded max-height. */}
      <div
        ref={bodyRef}
        id={bodyId}
        className="sb-disclosure-reveal"
        inert={!expanded}
        style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 200ms cubic-bezier(0.2, 0.7, 0.3, 1)',
        }}
      >
        <div style={{ overflow: 'hidden' }}>
          <div style={{ paddingTop: '10px' }}>
            <DiagnosticsBody
              snapshot={snapshot}
              error={error}
              feedback={feedback}
              buttonStyle={buttonStyle}
              onCopy={copy}
              onOpenLogs={openLogs}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export function DiagnosticsBody({
  snapshot, error, feedback, buttonStyle, onCopy, onOpenLogs,
}: {
  snapshot: DiagnosticsSnapshot | null
  error: string | null
  feedback: string | null
  buttonStyle: React.CSSProperties
  onCopy: () => void
  onOpenLogs: () => void
}) {
  if (error) {
    return <div style={{ fontSize: '12px', color: 'var(--error)' }}>Diagnostics unavailable: {error}</div>
  }
  if (!snapshot) {
    return <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Collecting...</div>
  }

  const top = sortProcessesByMemory(snapshot.processes).slice(0, DIAGNOSTICS_TOP_PROCESSES)
  const appMb = diagnosticsAppFootprintMb(snapshot.processes)
  const facts: Array<[string, string]> = [
    ['Chip', `${snapshot.arch}${snapshot.translated ? ' (running translated - install the native build)' : ''}`],
    ['OS', `${snapshot.platform} ${snapshot.osVersion}`],
    ['Electron', `${snapshot.versions.electron} (Chrome ${snapshot.versions.chrome}, Node ${snapshot.versions.node})`],
    ['Memory', `${formatMb(snapshot.memory.freeMb)} free of ${formatMb(snapshot.memory.totalMb)}; Switchboard uses ${formatMb(appMb)}`],
    ['Live', `${snapshot.livePtys ?? '?'} terminals, ${snapshot.liveSessions ?? '?'} agent sessions`],
  ]

  return (
    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', lineHeight: 1.6 }}>
        {facts.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <span style={{ color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ color: snapshot.translated && label === 'Chip' ? 'var(--warning)' : 'var(--text-primary)' }}>{value}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: '10px', color: 'var(--text-muted)', fontSize: '11px' }}>Largest processes</div>
      <div style={{
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: '11px',
        marginTop: '4px',
        display: 'grid',
        gridTemplateColumns: 'auto auto auto 1fr',
        gap: '2px 14px',
        color: 'var(--text-primary)',
      }}>
        {top.map((p) => (
          <div key={p.pid} style={{ display: 'contents' }}>
            <span>{p.type}</span>
            <span style={{ textAlign: 'right' }}>{p.cpuPercent.toFixed(1)}%</span>
            <span style={{ textAlign: 'right' }}>{formatMb(p.memoryMb)}</span>
            <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name ?? ''}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
        <button type="button" onClick={onCopy} style={buttonStyle}>Copy report</button>
        <button type="button" onClick={onOpenLogs} style={buttonStyle}>Open logs folder</button>
        {feedback && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{feedback}</span>}
      </div>
    </div>
  )
}

/**
 * About → Updates row. Renders the current updater status (idle /
 * checking / available / downloaded / etc.) plus a manual "Check for
 * updates" button that bypasses the launch-time auto-check, and -
 * once an update has been downloaded - a "Restart and install"
 * button. In dev (non-packaged) builds the row reports the
 * "unsupported" status since electron-updater has nothing to compare
 * against.
 */
function UpdateCheckRow() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const helpRef = useRef<HTMLDivElement>(null)
  // Main drops repeat fires too; this keeps the UI honest while teardown runs.
  const restartFired = useRef(false)

  useEffect(() => {
    let receivedLiveStatus = false
    const unsubscribe = window.api.app.onUpdateStatus((s) => {
      receivedLiveStatus = true
      setStatus(s)
      // Main un-latches and reports an error when the install never starts.
      // Clear the optimistic flag too, or the button stays dead for good.
      if (s.kind === 'error') {
        restartFired.current = false
        setRestarting(false)
      }
    })
    void window.api.app.getUpdateStatus().then((current) => {
      if (!receivedLiveStatus) setStatus(current)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!helpOpen) return
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!helpRef.current?.contains(event.target as Node)) setHelpOpen(false)
    }
    // Escape dismisses only the help, not Settings around it.
    const offEscape = onEscapeFirst(() => setHelpOpen(false))
    document.addEventListener('pointerdown', closeOnPointerDown)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      offEscape()
    }
  }, [helpOpen])

  const check = useCallback(async () => {
    setBusy(true)
    try {
      const result = await window.api.app.checkForUpdates()
      setStatus(result)
    } finally {
      setBusy(false)
    }
  }, [])

  const restart = useCallback(() => {
    if (restartFired.current) return
    restartFired.current = true
    setRestarting(true)
    window.api.app.quitAndInstall()
  }, [])

  const view = updateRowView(status, { checking: busy, restarting })
  const footerCopy = updateFooterCopy(
    navigator.platform.startsWith('Mac') ? 'darwin'
      : navigator.platform.startsWith('Win') ? 'win32'
        : 'linux',
  )

  const label = restarting
    ? updateStatusLabel({ kind: 'installing' })
    : updateStatusLabel(status)

  // `slow` deliberately stays secondary: the check is still running, so red
  // would report a failure that has not happened.
  const labelColor = status.kind === 'error'
    ? 'var(--error, #f85149)'
    : status.kind === 'downloaded' || status.kind === 'available'
      ? 'var(--accent)'
      : 'var(--text-secondary)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ fontSize: '12px', color: labelColor, lineHeight: 1.5 }}>
        {label}
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          onClick={check}
          disabled={view.checkDisabled}
          style={{
            padding: '6px 14px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)',
            borderRadius: '5px',
            color: 'var(--text-primary)',
            fontSize: '12px',
            cursor: view.checkDisabled ? 'default' : 'pointer',
            opacity: view.checkDisabled ? 0.6 : 1,
          }}
        >
          Check for updates
        </button>
        {view.showRestart && (
          <button
            type="button"
            onClick={restart}
            disabled={view.restartDisabled}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 14px',
              background: 'var(--accent)',
              border: '1px solid var(--accent)',
              borderRadius: '5px',
              color: 'var(--bg)',
              fontSize: '12px',
              fontWeight: 600,
              cursor: view.restartDisabled ? 'default' : 'pointer',
              opacity: view.restartDisabled ? 0.7 : 1,
            }}
          >
            {view.restartSpinning && (
              <span
                aria-hidden
                style={{
                  width: '11px',
                  height: '11px',
                  border: '2px solid currentColor',
                  borderTopColor: 'transparent',
                  borderRadius: '50%',
                  animation: 'sb-spin 720ms linear infinite',
                }}
              />
            )}
            {view.restartLabel}
          </button>
        )}
      </div>
      <div ref={helpRef} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          <span>{footerCopy.line}</span>
          {footerCopy.tooltip && (
            <button
              type="button"
              className="update-help-button"
              aria-label="About unsigned updates"
              aria-expanded={helpOpen}
              aria-describedby={helpOpen ? 'update-help-tooltip' : undefined}
              onClick={() => setHelpOpen((open) => !open)}
            >
              ?
            </button>
          )}
        </div>
        {footerCopy.tooltip && helpOpen && (
          <div
            id="update-help-tooltip"
            role="tooltip"
            className="update-help-tooltip"
          >
            {footerCopy.tooltip}
          </div>
        )}
      </div>
    </div>
  )
}
