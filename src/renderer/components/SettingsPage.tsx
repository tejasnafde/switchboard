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
import { useProviderInstanceStore } from '../stores/provider-instance-store'
import { AccountsPanel } from './settings/AccountsPanel'
import { MobilePairingTab } from './settings/MobilePairingTab'
import { LaunchConfigsPanel } from './settings/LaunchConfigsPanel'
import { ArchiveDataPage } from './settings/ArchiveDataPage'
import { WorktreeProtectionPanel } from './settings/WorktreeProtectionPanel'
import { useSettingValues, type SettingValues } from './settings/setting-values'
import {
  ALL_PROJECTS_SCOPE,
  launchConfigCount,
  overrideCount,
  projectSummary,
  scopedRow,
  scopeOptions,
  valueLabel,
  type ScopedRow,
} from './settings/project-scope'
import type { PickerProject } from './settings/project-picker-options'
import { useProjectSettingsStore } from '../stores/project-settings-store'
import { useLayoutStore } from '../stores/layout-store'
import { useAgentStore } from '../stores/agent-store'
import { settingsFileBanner, type SettingsFileStatus } from '@shared/settings-file'
import { settingsJsonOpenTarget } from './settings/settings-json-open'
import type { Workspace } from '@shared/types'
import {
  SETTINGS_PAGES,
  SETTING_ROW,
  PRIVACY_POLICY_URL,
  changedCountByPage,
  defaultValueLabel,
  isSettingChanged,
  pageTitle,
  searchSettingRows,
  shortcutRows,
  type SettingRowDef,
  type SettingsPageId,
} from './settings/settings-rows'
import { RECENT_SESSION_LIMITS } from './sidebar/recent-session-limit'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Combobox } from './ui/combobox'
import { onEscapeFirst } from './ui/escape-first'
import { cn } from '../lib/utils'
import { chordFromEvent, formatBinding, reservedShortcutReason, setShortcutCapture, shortcutClashesFor } from '@shared/shortcuts'

const log = createRendererLogger('component:settings')

interface SettingsPageProps {
  /** The page to show; null closes Settings. */
  page: SettingsPageId | null
  onNavigate: (page: SettingsPageId) => void
  onClose: () => void
}

interface SettingsContextValue extends SettingValues {
  highlight: string | null
  /** The project whose overrides Chat & agents shows and edits; null is All projects. */
  scope: string | null
  setScope: (scope: string | null) => void
  projects: PickerProject[]
  workspaces: Workspace[]
  /** Close Settings, for a row that opens something behind it. */
  close: () => void
}

const SettingsContext = createContext<SettingsContextValue>({
  values: {}, set: () => {}, highlight: null, scope: null, setScope: () => {}, projects: [], workspaces: [], close: () => {},
})

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

  // The account list is prewarmed so Accounts & models lays out its cards at
  // once. Usage is not: a Claude usage read can be a macOS password prompt,
  // so only Accounts itself reads it.
  const open = page !== null
  useEffect(() => {
    if (open) void useProviderInstanceStore.getState().refresh()
  }, [open])

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
  const [scope, setScope] = useState<string | null>(null)
  const { projects, workspaces } = useSettingsProjects()
  const changed = useMemo(() => changedCountByPage(settingValues.values), [settingValues.values])
  // Values in the deps: a rebind changes which keys a shortcut row is found by.
  const results = useMemo(() => searchSettingRows(query), [query, settingValues.values])
  const searching = query.trim() !== ''
  const context = useMemo(
    () => ({ ...settingValues, highlight, scope, setScope, projects, workspaces, close: onClose }),
    [settingValues, highlight, scope, projects, workspaces, onClose],
  )

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
          <SettingsFileBanner />
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

/** The projects and workspaces the Scope control and the Projects page list, loaded once per open. */
function useSettingsProjects(): { projects: PickerProject[]; workspaces: Workspace[] } {
  const [projects, setProjects] = useState<PickerProject[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  useEffect(() => {
    window.api.app.getProjects()
      .then((rows: PickerProject[]) => {
        setProjects(rows ?? [])
        void useProjectSettingsStore.getState().load((rows ?? []).map((row) => row.path))
      })
      .catch((err: unknown) => log.warn('getProjects failed, the Scope control lists no projects', err))
    window.api.app.workspaces.list()
      .then((list: Workspace[]) => setWorkspaces(list ?? []))
      .catch((err: unknown) => log.warn('workspaces.list failed, the Scope control shows no workspace groups', err))
  }, [])
  return { projects, workspaces }
}

function projectName(projects: PickerProject[], path: string): string {
  return projects.find((project) => project.path === path)?.name ?? path
}

function SearchResults({ query, results, onOpen }: { query: string; results: SettingRowDef[]; onOpen: (row: SettingRowDef) => void }) {
  const trimmed = query.trim()
  const { values, scope, projects } = useContext(SettingsContext)
  const overrides = useProjectSettingsStore((state) => (scope ? state.byProject[scope] : undefined))
  return (
    <>
      <h2 className="mb-1 text-[18px] font-[600]">
        {results.length} result{results.length === 1 ? '' : 's'} for "{trimmed}"
      </h2>
      <p className="mb-[18px] text-[13px] text-[var(--text-secondary)]">
        Every page is searched.{scope && ` Chat & agents values are for ${projectName(projects, scope)}.`}
      </p>
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
            {!row.keys && row.defaultValue !== undefined && (
              <ResultValue row={row} state={scopedRow(row, scope, values[row.id], overrides)} />
            )}
            <span className="shrink-0 text-[11.5px] text-[var(--text-muted)]">Open</span>
          </button>
        ))}
      </SettingsCard>
    </>
  )
}

function ResultValue({ row, state }: { row: SettingRowDef; state: ScopedRow }) {
  const label = valueLabel(row, state.value)
  if (label === undefined) return null
  return (
    <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">
      {label}
      {state.overridden && <span className="ml-1.5 text-[11px] text-[var(--text-muted)]">• Overridden</span>}
    </span>
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
          <Section title={SETTING_ROW.projectList.section}>
            <SettingAnchor def={SETTING_ROW.projectList}><ProjectList onNavigate={onNavigate} /></SettingAnchor>
          </Section>
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
      <ScopeControl />
      <Section title="While the agent works" card>
        <SettingRow def={SETTING_ROW.followUp}>
          <SegmentedControl def={SETTING_ROW.followUp} options={SETTING_ROW.followUp.options!} />
        </SettingRow>
        <SettingRow def={SETTING_ROW.streaming}>
          <ToggleControl def={SETTING_ROW.streaming} />
        </SettingRow>
        <SettingRow def={SETTING_ROW.linkDuration}>
          <SelectControl def={SETTING_ROW.linkDuration} options={SETTING_ROW.linkDuration.options!} />
        </SettingRow>
      </Section>
      <Section title="Defaults for new chats" card>
        <SettingRow def={SETTING_ROW.envMode}>
          <SelectControl def={SETTING_ROW.envMode} options={SETTING_ROW.envMode.options!} />
        </SettingRow>
        <SettingRow def={SETTING_ROW.runtimeMode}>
          <SelectControl def={SETTING_ROW.runtimeMode} options={SETTING_ROW.runtimeMode.options!} />
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

/**
 * Chat & agents' Scope: All projects edits the global values; a project
 * shows its effective values and edits its overrides.
 */
function ScopeControl() {
  const { scope, setScope, projects, workspaces } = useContext(SettingsContext)
  const byProject = useProjectSettingsStore((state) => state.byProject)
  const options = useMemo(() => scopeOptions(projects, workspaces, byProject), [projects, workspaces, byProject])
  return (
    <div className="mb-[18px]">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-[var(--text-secondary)]">Scope</span>
        <Combobox
          aria-label="Scope"
          value={scope ?? ALL_PROJECTS_SCOPE}
          onValueChange={(value) => setScope(value === ALL_PROJECTS_SCOPE ? null : value)}
          options={options}
          searchPlaceholder="Search projects"
          emptyText="No project matches."
          className="min-w-[180px] max-w-[320px]"
        />
      </div>
      {scope && (
        <p data-testid="settings-scope-note" className="mt-2 text-[12px] text-[var(--text-secondary)]">
          Overrides for <b className="font-[600] text-[var(--text-primary)]">{projectName(projects, scope)}</b>. A row with no override uses the All projects value.
        </p>
      )}
    </div>
  )
}

/** Settings > Projects: one row per project with its counts, and Open, which shows its scope on Chat & agents. */
function ProjectList({ onNavigate }: { onNavigate?: (page: SettingsPageId) => void }) {
  const { projects, setScope } = useContext(SettingsContext)
  const byProject = useProjectSettingsStore((state) => state.byProject)
  const [launchConfigs, setLaunchConfigs] = useState<Record<string, number>>({})

  useEffect(() => {
    let cancelled = false
    for (const project of projects) {
      window.api.app.getLaunchConfig(project.path)
        .then((yaml: string | null) => {
          if (!cancelled) setLaunchConfigs((prev) => ({ ...prev, [project.path]: launchConfigCount(yaml) }))
        })
        .catch((err: unknown) => log.warn(`could not count the launch configs of ${project.path}`, err))
    }
    return () => { cancelled = true }
  }, [projects])

  if (projects.length === 0) {
    return <div className="text-[12px] text-[var(--text-muted)]">No projects added yet.</div>
  }
  return (
    <SettingsCard>
      {projects.map((project) => (
        <div key={project.path} data-project-row={project.path} className="flex items-center gap-4 border-t border-[var(--border)] px-[14px] py-2.5 first:border-t-0">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-[500]" title={project.path}>{project.name}</div>
            <div className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
              {projectSummary(launchConfigs[project.path], overrideCount(byProject[project.path]))}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Open ${project.name} overrides`}
            onClick={() => {
              setScope(project.path)
              onNavigate?.('chat')
            }}
          >
            Open
          </Button>
        </div>
      ))}
    </SettingsCard>
  )
}

function KeyboardPage() {
  const { values, set } = useContext(SettingsContext)
  const [filter, setFilter] = useState('')
  // Rebuilt each render so labels and filtering follow the keys in effect.
  const rows = shortcutRows()
  const shown = filter.trim() ? searchSettingRows(filter, rows) : rows
  const changed = rows.filter((row) => isSettingChanged(row, values))
  const groups = [...new Set(shown.map((row) => row.section))]
  return (
    <>
      <div className="mb-3 flex items-center gap-2.5">
        <input
          type="search"
          aria-label="Filter shortcuts"
          placeholder="Filter shortcuts"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="min-w-0 flex-1 rounded-[7px] border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus-visible:border-[var(--border-focus)]"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={changed.length === 0}
          onClick={() => { for (const row of changed) set(row.id, row.defaultValue!) }}
        >
          Reset all
        </Button>
      </div>
      {groups.length === 0 && <p className="text-[12.5px] text-[var(--text-secondary)]">No shortcut matches.</p>}
      {groups.map((group) => (
        <Section key={group} title={group} card>
          {shown.filter((row) => row.section === group).map((def) => (
            <SettingRow key={def.id} def={def}>
              {def.defaultValue !== undefined ? <ShortcutRecorder def={def} /> : <Kbd>{def.keys}</Kbd>}
            </SettingRow>
          ))}
        </Section>
      ))}
    </>
  )
}

/**
 * Click, then press the new keys. Escape cancels, Backspace unbinds. A chord
 * the OS or the terminal owns, or one another command already uses, is
 * refused with the reason and recording carries on.
 */
function ShortcutRecorder({ def }: { def: SettingRowDef }) {
  const [value, setValue] = useRowValue(def)
  const [recording, setRecording] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const command = def.command!

  useEffect(() => {
    if (!recording) return
    setShortcutCapture(true)
    window.api.setShortcutCapture?.(true)
    const stop = () => {
      setRecording(false)
      setProblem(null)
    }
    // Window capture runs ahead of the app's shortcuts and the dialog's Escape.
    const listener = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      if (bare && event.key === 'Escape') return stop()
      if (bare && event.key === 'Backspace') {
        setValue('')
        return stop()
      }
      const chord = chordFromEvent(event)
      if (!chord) return
      const reason = reservedShortcutReason(chord)
      if (reason) return setProblem(`${formatBinding(chord)}: ${reason}`)
      const clashes = shortcutClashesFor(command, chord)
      if (clashes.length > 0) {
        return setProblem(`${formatBinding(chord)} is already ${clashes.map((c) => c.label).join(', ')}. Change that one first.`)
      }
      setValue(chord)
      stop()
    }
    window.addEventListener('keydown', listener, true)
    return () => {
      window.removeEventListener('keydown', listener, true)
      setShortcutCapture(false)
      window.api.setShortcutCapture?.(false)
    }
  }, [recording, command, setValue])

  const first = value === undefined ? undefined : value.split(' ')[0]
  const label = first === undefined ? def.keys : first ? formatBinding(first) : ''
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        aria-label={`Change the shortcut for ${def.label}`}
        aria-pressed={recording}
        title="Click, then press the new keys. Escape cancels, Backspace unbinds."
        onClick={() => { setRecording((r) => !r); setProblem(null) }}
        onBlur={() => { setRecording(false); setProblem(null) }}
        className={cn(
          'cursor-pointer whitespace-nowrap rounded-[5px] border border-b-2 px-1.5 py-[1px] text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
          recording
            ? 'border-[var(--border-focus)] bg-[var(--accent-subtle)] text-[var(--text-primary)]'
            : 'border-[var(--border)] bg-[var(--bg-tertiary)] [font-family:var(--font-mono)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
        )}
      >
        {recording ? 'Press the new shortcut' : label || <span className="text-[var(--text-muted)]">Not set</span>}
      </button>
      {problem && <div role="alert" className="max-w-[300px] text-right text-[11.5px] text-[var(--warning)]">{problem}</div>}
    </div>
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
      <Section title={SETTING_ROW.settingsJson.section} card>
        <SettingsJsonRow />
      </Section>
      <SettingAnchor def={SETTING_ROW.diagnostics}>
        <DiagnosticsSection />
      </SettingAnchor>
    </>
  )
}

function SettingsJsonRow() {
  const { close } = useContext(SettingsContext)
  const available = typeof window !== 'undefined' && window.api?.settingsFile?.available === true
  const [problem, setProblem] = useState<string | null>(null)
  const open = async () => {
    setProblem(null)
    try {
      const { path } = await window.api.settingsFile.open()
      const layout = useLayoutStore.getState()
      const sessionId = layout.companionSessionId()
      const session = useAgentStore.getState().sessions.find((s) => s.id === sessionId)
      if (settingsJsonOpenTarget(session) === 'ide') {
        layout.openInViewer(path, null, sessionId)
        close()
        return
      }
      const opened = await window.api.settingsFile.openExternal()
      if (!opened.ok) setProblem(`Wrote ${path}, but no editor opened it: ${opened.error ?? 'unknown error'}.`)
    } catch (err) {
      log.warn('opening settings.json failed', err)
      setProblem('Could not write settings.json. The log has the reason.')
    }
  }
  return (
    <SettingRow
      def={SETTING_ROW.settingsJson}
      below={
        !available
          ? <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">The file is beside this Mac's settings, and this window uses a remote backend's.</div>
          : problem && <div role="alert" className="mt-0.5 text-[11.5px] text-[var(--warning)]">{problem}</div>
      }
    >
      <Button variant="outline" size="sm" disabled={!available} onClick={() => void open()}>Open</Button>
    </SettingRow>
  )
}

/** One line naming what the last settings.json save could not apply, or a write it skipped. */
function SettingsFileBanner() {
  const [status, setStatus] = useState<SettingsFileStatus | null>(null)
  useEffect(() => {
    const api = window.api.settingsFile
    if (!api?.available) return
    let cancelled = false
    api.status()
      .then((next) => { if (!cancelled) setStatus(next) })
      .catch((err) => log.warn('reading the settings.json status failed', err))
    const off = api.onStatus(setStatus)
    return () => {
      cancelled = true
      off()
    }
  }, [])
  const line = status && settingsFileBanner(status)
  if (!line) return null
  return (
    <div
      role="status"
      title={line}
      data-testid="settings-file-banner"
      className="mb-3 truncate rounded-[7px] border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1.5 text-[12px] text-[var(--warning)]"
    >
      {line}
    </div>
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
 * the default, and the control. In a project's scope the marker is
 * "Overridden" instead and Reset removes the override.
 */
function SettingRow({ def, extra, below, children }: {
  def: SettingRowDef
  /** Shown after the description, e.g. a link or a live status. */
  extra?: ReactNode
  /** A block under the text, for rows whose control is more than one widget. */
  below?: ReactNode
  children?: ReactNode
}) {
  const { values, set, scope } = useContext(SettingsContext)
  const { ref, active } = useHighlightTarget(def.id)
  const scoped = useScopedRow(def)
  const inScope = scope !== null && def.page === 'chat'
  const changed = !inScope && isSettingChanged(def, values)
  const removeOverride = useProjectSettingsStore((state) => state.removeOverride)
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-setting-row={def.id}
      data-changed={changed || undefined}
      data-overridden={scoped.overridden || undefined}
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
          {scoped.overridden && (
            <span
              title={`Overrides the All projects value (${valueLabel(def, values[def.id]) ?? ''})`}
              className="ml-2 inline-flex shrink-0 cursor-default items-center gap-[5px] text-[11px] font-[500] tracking-[0.02em] text-[var(--text-muted)]"
            >
              <span aria-hidden="true" className="size-[5px] rounded-full bg-[var(--text-secondary)]" />
              Overridden
            </span>
          )}
        </div>
        {(def.description || extra) && (
          <div className="mt-0.5 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
            {def.description}{def.description && extra ? ' ' : null}{extra}
          </div>
        )}
        {scoped.disabledReason && (
          <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">{scoped.disabledReason}</div>
        )}
        {below}
      </div>
      {scoped.overridden && def.scopeKey && scope && (
        <button
          type="button"
          data-setting-reset
          aria-label={`Reset ${def.label} override`}
          onClick={() => void removeOverride(scope, def.scopeKey!)}
          className="shrink-0 cursor-pointer rounded-[4px] border-0 bg-transparent px-1 text-[11.5px] text-[var(--text-muted)] outline-none hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-ring"
        >
          Reset
        </button>
      )}
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

function useScopedRow(def: SettingRowDef): ScopedRow {
  const { values, scope } = useContext(SettingsContext)
  const overrides = useProjectSettingsStore((state) => (scope ? state.byProject[scope] : undefined))
  return scopedRow(def, scope, values[def.id], overrides)
}

/** The value a control shows, its setter (an override in a project's scope), and whether it is disabled. */
function useRowValue(def: SettingRowDef): [string | undefined, (value: string) => void, boolean] {
  const { set, scope } = useContext(SettingsContext)
  const scoped = useScopedRow(def)
  const setOverride = useProjectSettingsStore((state) => state.setOverride)
  const write = useCallback((value: string) => {
    if (scope && def.page === 'chat' && def.scopeKey) void setOverride(scope, def.scopeKey, value)
    else set(def.id, value)
  }, [set, setOverride, scope, def])
  return [scoped.value, write, scoped.value === undefined || scoped.disabledReason !== undefined]
}

function ToggleControl({ def, onToggle }: { def: SettingRowDef; onToggle?: (on: boolean) => void }) {
  const [value, setValue, disabled] = useRowValue(def)
  const on = value === 'true'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelId(def.id)}
      disabled={disabled}
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

function SelectControl({ def, options }: { def: SettingRowDef; options: ReadonlyArray<{ value: string; label: string }> }) {
  const [value, setValue, disabled] = useRowValue(def)
  return (
    <Combobox
      searchable={false}
      aria-label={def.label}
      value={value ?? def.defaultValue ?? ''}
      disabled={disabled}
      onValueChange={setValue}
      options={[...options]}
      className="shrink-0"
    />
  )
}

function SegmentedControl({ def, options }: { def: SettingRowDef; options: ReadonlyArray<{ value: string; label: string }> }) {
  const [value, setValue, disabled] = useRowValue(def)
  return (
    <div role="group" aria-labelledby={labelId(def.id)} className="inline-flex shrink-0 overflow-hidden rounded-[6px] border border-[var(--border)]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={disabled}
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
