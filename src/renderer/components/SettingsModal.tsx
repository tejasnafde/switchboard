import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useThemeStore, type ThemeName } from '../stores/theme-store'
import { useLayoutStore } from '../stores/layout-store'
import { parseFollowUpDefault } from '@shared/turn-delivery'
import { emitSessionRename } from '../services/session-events'
import { FEATURE_TOUR_STEPS } from './onboarding/featureRegistry'
import type { UpdateStatus } from '@shared/update-status'
import { updateRowView, updateStatusLabel } from './settings/updateRowModel'
import { updateFooterCopy } from './settings/updateFooterCopy'
import { selectArchivedPage, type ArchivedRow } from './settings/archivedList'
import {
  parseLaunchConfigFile,
  serializeLaunchConfigFile,
  serializeLaunchConfigBody,
  parseLaunchConfigBodyYaml,
  type LaunchConfigFile,
  type WorktreeSetupConfig,
} from '@shared/launch-config'
import { launchConfigListReducer } from '../services/launchConfigListReducer'
import {
  areNotificationsEnabled,
  setNotificationsEnabled,
  fireTestNotification,
  currentNotificationPermission,
} from '../services/notifications'
import {
  getDefaultSessionEnvMode,
  setDefaultSessionEnvMode,
  type SessionEnvMode,
} from '../services/sessionEnvMode'
import {
  isAssistantStreamingEnabled,
  setAssistantStreamingEnabled,
} from '../services/streamingPref'
import { isAnalyticsEnabled, setAnalyticsEnabled } from '../services/analyticsPref'
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
import { ProvidersTab } from './settings/ProvidersTab'
import { MobilePairingTab } from './settings/MobilePairingTab'
import {
  DEFAULT_RECENT_SESSION_LIMIT,
  RECENT_SESSION_LIMIT_CHANGED,
  RECENT_SESSION_LIMIT_SETTING,
  RECENT_SESSION_LIMITS,
  parseRecentSessionLimit,
  resolveLoadedRecentSessionLimit,
  type RecentSessionLimit,
} from './sidebar/recentSessionLimit'
import { confirm } from './ui/confirm'

const log = createRendererLogger('component:settings')

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const THEMES: { value: ThemeName; label: string; desc: string }[] = [
  { value: 'dark', label: 'Dark', desc: 'Default dark interface' },
  { value: 'light', label: 'Light', desc: 'Clean light interface' },
  { value: 'translucent', label: 'Translucent', desc: 'Blurred desktop vibrancy (macOS)' },
  { value: 'system', label: 'System', desc: 'Follow OS light/dark appearance' },
]

const DEFAULT_LAUNCH_CONFIG_YAML = `# Terminals to spawn when a chat in this project is opened.
# Each terminal is given a cwd (relative to project root) and an optional
# on_start command that runs after the shell initializes.
#
# Example:
# terminals:
#   - label: server
#     cwd: "."
#     on_start: "npm run dev"
#   - label: tests
#     cwd: "."
#     on_start: "npm test --watch"

terminals: []
`

// Settings tab ids render capitalized as-is; only multi-word tabs need a label.
const TAB_LABELS: Record<string, string> = { launchConfigs: 'Launch Configs' }

interface LaunchConfigProjectRow {
  path: string
  name: string
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { theme, setTheme } = useThemeStore()
  const [activeTab, setActiveTab] = useState<'general' | 'providers' | 'mobile' | 'launchConfigs' | 'archived' | 'tour' | 'about'>('general')
  const [archived, setArchived] = useState<ArchivedRow[]>([])
  const [loadingArchived, setLoadingArchived] = useState(false)
  const [archivedQuery, setArchivedQuery] = useState('')
  const [archivedPageNum, setArchivedPageNum] = useState(1)
  const [launchConfigProjects, setLaunchConfigProjectRows] = useState<LaunchConfigProjectRow[]>([])
  const [selectedLaunchConfigProject, setSelectedLaunchConfigProject] = useState<string | null>(null)
  // Parsed config drives the launch config list. The body editor is a per-launch config
  // YAML buffer; on save we feed it back into the reducer + serialize.
  const [launchConfigFile, setLaunchConfigFile] = useState<LaunchConfigFile>({ terminals: [], configs: { default: { terminals: [] } } })
  const [selectedLaunchConfig, setSelectedLaunchConfig] = useState<string>('default')
  const [bodyYaml, setBodyYaml] = useState('')
  const [bodyDirty, setBodyDirty] = useState(false)
  const [configSaveState, setConfigSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [configError, setConfigError] = useState<string | null>(null)
  const [renamingLaunchConfig, setRenamingLaunchConfig] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [addingLaunchConfig, setAddingLaunchConfig] = useState(false)
  const [addValue, setAddValue] = useState('')
  const [setupCommand, setSetupCommand] = useState('')
  const [setupDefaultPolicy, setSetupDefaultPolicy] = useState<WorktreeSetupConfig['defaultPolicy']>('ask')
  const [setupStartupPolicy, setSetupStartupPolicy] = useState<WorktreeSetupConfig['startupPolicy']>('wait-for-setup')

  const loadArchived = useCallback(async () => {
    setLoadingArchived(true)
    try {
      const rows = await window.api.app.getArchivedConversations()
      setArchived(rows ?? [])
      setArchivedPageNum(1)
    } catch (err) {
      log.warn('could not load archived conversations', err)
      setArchived([])
    } finally {
      setLoadingArchived(false)
    }
  }, [])

  useEffect(() => {
    if (open && activeTab === 'archived') loadArchived()
  }, [open, activeTab, loadArchived])

  // Launch Configs tab - load project list once
  useEffect(() => {
    if (!open || activeTab !== 'launchConfigs') return
    window.api.app.getProjects().then((rows: LaunchConfigProjectRow[]) => {
      setLaunchConfigProjectRows(rows ?? [])
      if (rows?.length && !selectedLaunchConfigProject) setSelectedLaunchConfigProject(rows[0].path)
    }).catch((err) => {
      log.warn('getProjects failed for launch configs tab', err)
    })
  }, [open, activeTab, selectedLaunchConfigProject])

  // When selected project changes, load + parse its yaml
  useEffect(() => {
    if (!selectedLaunchConfigProject) return
    window.api.app.getLaunchConfig(selectedLaunchConfigProject).then((yaml: string | null) => {
      const text = yaml ?? DEFAULT_LAUNCH_CONFIG_YAML
      let parsed: LaunchConfigFile
      try {
        parsed = parseLaunchConfigFile(text)
      } catch {
        parsed = { terminals: [], configs: { default: { terminals: [] } } }
      }
      // Ensure `default` always exists - the reducer + lifecycle assume it.
      if (!parsed.configs || !parsed.configs.default) {
        parsed = {
          ...parsed,
          configs: { default: { terminals: parsed.terminals ?? [], rows: parsed.rows }, ...(parsed.configs ?? {}) },
        }
      }
      setLaunchConfigFile(parsed)
      setSelectedLaunchConfig('default')
      setBodyYaml(serializeLaunchConfigBody(parsed.configs!.default))
      setBodyDirty(false)
      setConfigSaveState('idle')
      setConfigError(null)
      setSetupCommand(parsed.worktree?.setup.command ?? '')
      setSetupDefaultPolicy(parsed.worktree?.setup.defaultPolicy ?? 'ask')
      setSetupStartupPolicy(parsed.worktree?.setup.startupPolicy ?? 'wait-for-setup')
    }).catch(() => {
      const fresh: LaunchConfigFile = { terminals: [], configs: { default: { terminals: [] } } }
      setLaunchConfigFile(fresh)
      setSelectedLaunchConfig('default')
      setBodyYaml(serializeLaunchConfigBody(fresh.configs!.default))
      setBodyDirty(false)
    })
  }, [selectedLaunchConfigProject])

  // When the user picks a different launch config name, swap the body editor.
  useEffect(() => {
    const tpl = launchConfigFile.configs?.[selectedLaunchConfig]
    if (!tpl) return
    setBodyYaml(serializeLaunchConfigBody(tpl))
    setBodyDirty(false)
    setConfigError(null)
  }, [selectedLaunchConfig, launchConfigFile])

  const persist = useCallback(async (config: LaunchConfigFile) => {
    if (!selectedLaunchConfigProject) return
    setConfigSaveState('saving')
    setConfigError(null)
    try {
      const text = serializeLaunchConfigFile(config)
      await window.api.app.saveLaunchConfig(selectedLaunchConfigProject, text)
      setLaunchConfigFile(config)
      setConfigSaveState('saved')
      setTimeout(() => setConfigSaveState('idle'), 1500)
    } catch (e) {
      setConfigSaveState('error')
      setConfigError(e instanceof Error ? e.message : String(e))
    }
  }, [selectedLaunchConfigProject])

  const handleSaveBody = useCallback(async () => {
    let body
    try {
      body = parseLaunchConfigBodyYaml(bodyYaml)
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : 'Invalid YAML')
      setConfigSaveState('error')
      return
    }
    if (!body) {
      setConfigError('Launch config body must define `terminals:` or `rows:`.')
      setConfigSaveState('error')
      return
    }
    const result = launchConfigListReducer(launchConfigFile, { type: 'replaceLaunchConfigBody', name: selectedLaunchConfig, body })
    if (!result.ok) {
      setConfigError(result.error)
      setConfigSaveState('error')
      return
    }
    await persist(result.config)
    setBodyDirty(false)
  }, [bodyYaml, launchConfigFile, selectedLaunchConfig, persist])

  const handleAddLaunchConfig = useCallback(async () => {
    const name = addValue.trim()
    if (!name) { setAddingLaunchConfig(false); return }
    const result = launchConfigListReducer(launchConfigFile, { type: 'addLaunchConfig', name })
    if (!result.ok) {
      setConfigError(result.error)
      return
    }
    await persist(result.config)
    setSelectedLaunchConfig(name)
    setAddingLaunchConfig(false)
    setAddValue('')
  }, [addValue, launchConfigFile, persist])

  const handleRenameLaunchConfig = useCallback(async (from: string) => {
    const to = renameValue.trim()
    if (!to || to === from) { setRenamingLaunchConfig(null); return }
    const result = launchConfigListReducer(launchConfigFile, { type: 'renameLaunchConfig', from, to })
    if (!result.ok) {
      setConfigError(result.error)
      return
    }
    await persist(result.config)
    if (selectedLaunchConfig === from) setSelectedLaunchConfig(to)
    setRenamingLaunchConfig(null)
    setRenameValue('')
  }, [renameValue, launchConfigFile, selectedLaunchConfig, persist])

  const handleDeleteLaunchConfig = useCallback(async (name: string) => {
    const result = launchConfigListReducer(launchConfigFile, { type: 'deleteLaunchConfig', name })
    if (!result.ok) {
      setConfigError(result.error)
      return
    }
    await persist(result.config)
    if (selectedLaunchConfig === name) setSelectedLaunchConfig('default')
  }, [launchConfigFile, selectedLaunchConfig, persist])

  const handleSaveWorktreeSetup = useCallback(async () => {
    const result = launchConfigListReducer(launchConfigFile, {
      type: 'replaceWorktreeSetup',
      setup: {
        ...(setupCommand.trim() ? { command: setupCommand.trim() } : {}),
        defaultPolicy: setupDefaultPolicy,
        startupPolicy: setupStartupPolicy,
      },
    })
    if (!result.ok) {
      setConfigError(result.error)
      return
    }
    await persist(result.config)
  }, [launchConfigFile, persist, setupCommand, setupDefaultPolicy, setupStartupPolicy])

  const launchConfigNames = useMemo(() => {
    const names = Object.keys(launchConfigFile.configs ?? {})
    return names.sort((a, b) => {
      if (a === 'default') return -1
      if (b === 'default') return 1
      return a.localeCompare(b)
    })
  }, [launchConfigFile])

  const archivedView = useMemo(
    () => selectArchivedPage(archived, archivedQuery, archivedPageNum),
    [archived, archivedQuery, archivedPageNum],
  )

  const handleUnarchive = useCallback(async (conv: ArchivedRow) => {
    setArchived((prev) => prev.filter((c) => c.id !== conv.id))
    try {
      await window.api.app.unarchiveConversation(conv.id)
      // Trigger sidebar refresh via rename event (same title - just to nudge the list)
      emitSessionRename(conv.id, conv.title)
      // Also dispatch a generic event to prompt project reload
      window.dispatchEvent(new CustomEvent('sidebar-refresh'))
    } catch (err) {
      // Re-sort on the backend's key: appending would put the row last, and
      // with paging, on a different page than the one it was clicked on.
      log.warn('unarchive failed, restoring the row', err)
      setArchived((prev) => [...prev, conv].sort((a, b) => b.updated_at - a.updated_at))
    }
  }, [])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="settings-modal-content"
        style={{
          width: '520px',
          maxHeight: '70vh',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontWeight: 600, fontSize: '14px' }}>Settings</span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '18px',
              lineHeight: 1,
              padding: '2px 6px',
              borderRadius: '4px',
            }}
          >
            &times;
          </button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex',
          borderBottom: '1px solid var(--border)',
          padding: '0 18px',
          gap: '0',
        }}>
          {(['general', 'providers', 'mobile', 'launchConfigs', 'archived', 'tour', 'about'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '8px 14px',
                background: 'none',
                border: 'none',
                borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: activeTab === tab ? 600 : 400,
                textTransform: 'capitalize',
                transition: 'color 0.12s',
              }}
            >
              {TAB_LABELS[tab] ?? tab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 18px' }}>
          {activeTab === 'general' && (
            <div>
              {/* Notifications */}
              <SettingsSection title="Notifications">
                <NotificationToggle />
              </SettingsSection>

              {/* Theme */}
              <SettingsSection title="Appearance">
                <SettingsLabel label="Theme" />
                <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                  {THEMES.map((t) => (
                    <button
                      key={t.value}
                      onClick={() => setTheme(t.value)}
                      style={{
                        flex: 1,
                        padding: '10px 12px',
                        borderRadius: 'var(--radius)',
                        // Always 1px border; use outline to indicate the
                        // active theme so no layout shift happens when
                        // switching between options.
                        border: '1px solid var(--border)',
                        outline: theme === t.value ? '2px solid var(--accent)' : 'none',
                        outlineOffset: '-2px',
                        background: theme === t.value ? 'var(--accent-subtle)' : 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'all 0.12s',
                      }}
                    >
                      <div style={{ fontWeight: 500, fontSize: '12px' }}>{t.label}</div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{t.desc}</div>
                    </button>
                  ))}
                </div>
              </SettingsSection>

              {/* Threads - default workspace mode for new sessions */}
              <SettingsSection title="Threads">
                <DefaultEnvModeToggle />
                <RecentConversationsSetting />
                <FollowUpDefaultSetting />
              </SettingsSection>

              {/* Embedded IDE - idle shutdown TTL */}
              <SettingsSection title="Embedded IDE">
                <IdeIdleTtlSetting />
              </SettingsSection>

              {/* Responses - token-by-token streaming gate */}
              <SettingsSection title="Responses">
                <StreamAssistantToggle />
                <FileDiffCardsToggle />
              </SettingsSection>

              {/* Privacy - anonymous usage counts, default on */}
              <SettingsSection title="Privacy">
                <AnalyticsToggle />
              </SettingsSection>

              {/* Keyboard shortcuts info */}
              <SettingsSection title="Keyboard Shortcuts">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 16px', fontSize: '12px' }}>
                  <ShortcutRow label="Toggle sidebar" keys={'⌘B'} />
                  <ShortcutRow label="Toggle terminal" keys={'⌘J'} />
                  <ShortcutRow label="Command palette" keys={'⌘⇧P'} />
                  <ShortcutRow label="Search across chats" keys={'⌘⇧F'} />
                  <ShortcutRow label="Open settings" keys={'⌘,'} />
                  <ShortcutRow label="Send message" keys="Enter" />
                  <ShortcutRow label="New line in message" keys="Shift+Enter" />
                  <ShortcutRow label="Stop agent (when running)" keys={'⌘⌫'} />
                  <ShortcutRow label="Quick prompt (Spotlight-style)" keys={'⌘K'} />
                  <ShortcutRow label="Send terminal selection to chat" keys={'⌘L'} />
                  <ShortcutRow label="Toggle dual-chat panel" keys={'⌘⇧\\'} />

                  {/* Terminals */}
                  <ShortcutRow label="New window (right)" keys={'⌘T'} />
                  <ShortcutRow label="New window (below)" keys={'⌘⇧T'} />
                  <ShortcutRow label="New tab in active window" keys={'⌘\\'} />
                  <ShortcutRow label="Close active tab" keys={'⌘W'} />
                  <ShortcutRow label="Close active window" keys={'⌘⇧W'} />
                  <ShortcutRow label="Next tab" keys={'⌘⇧]'} />
                  <ShortcutRow label="Prev tab" keys={'⌘⇧['} />
                  <ShortcutRow label="Focus window N" keys={'⌘1…9'} />
                  <ShortcutRow label="Navigate windows" keys={'⌘⌥←↑↓→'} />
                </div>
              </SettingsSection>
            </div>
          )}

          {activeTab === 'providers' && <ProvidersTab />}

          {activeTab === 'mobile' && (
            <SettingsSection title="Mobile Pairing">
              <MobilePairingTab />
            </SettingsSection>
          )}

          {activeTab === 'launchConfigs' && (
            <div>
              <SettingsSection title="Project Launch Configs">
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px', lineHeight: 1.6 }}>
                  Each project defines named terminal configs in <code style={{ fontFamily: 'var(--font-mono)' }}>&lt;project&gt;/.switchboard/launch-config.yaml</code>.
                  New chats start from the <code style={{ fontFamily: 'var(--font-mono)' }}>default</code> launch config;
                  switch configs per chat from the terminal strip header.
                </div>

                {launchConfigProjects.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    No projects added yet. Click "+ Add Project" in the sidebar first.
                  </div>
                ) : (
                  <>
                    <select
                      value={selectedLaunchConfigProject ?? ''}
                      onChange={(e) => setSelectedLaunchConfigProject(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        borderRadius: '4px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        fontSize: '12px',
                        marginBottom: '10px',
                        outline: 'none',
                      }}
                    >
                      {launchConfigProjects.map((p) => (
                        <option key={p.path} value={p.path}>{p.name}</option>
                      ))}
                    </select>

                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(180px, 1fr) 150px 170px auto',
                      gap: '8px',
                      alignItems: 'end',
                      marginBottom: '10px',
                      padding: '10px',
                      border: '1px solid var(--border)',
                      borderRadius: '4px',
                      background: 'var(--bg-tertiary)',
                    }}>
                      <label style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        Worktree setup command
                        <input
                          value={setupCommand}
                          onChange={(event) => setSetupCommand(event.target.value)}
                          placeholder="Not configured"
                          style={{ width: '100%', marginTop: '4px', padding: '5px 7px', border: '1px solid var(--border)', borderRadius: '3px', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}
                        />
                      </label>
                      <label style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        Default policy
                        <select
                          value={setupDefaultPolicy}
                          onChange={(event) => setSetupDefaultPolicy(event.target.value as WorktreeSetupConfig['defaultPolicy'])}
                          style={{ width: '100%', marginTop: '4px', padding: '5px 7px', border: '1px solid var(--border)', borderRadius: '3px', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '11px' }}
                        >
                          <option value="ask">Ask</option>
                          <option value="run">Run</option>
                          <option value="skip">Skip</option>
                        </select>
                      </label>
                      <label style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        Workspace startup
                        <select
                          value={setupStartupPolicy}
                          onChange={(event) => setSetupStartupPolicy(event.target.value as WorktreeSetupConfig['startupPolicy'])}
                          style={{ width: '100%', marginTop: '4px', padding: '5px 7px', border: '1px solid var(--border)', borderRadius: '3px', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '11px' }}
                        >
                          <option value="wait-for-setup">Wait for setup</option>
                          <option value="start-immediately">Start immediately</option>
                        </select>
                      </label>
                      <button
                        onClick={handleSaveWorktreeSetup}
                        style={{ padding: '6px 12px', border: 'none', borderRadius: '4px', background: 'var(--accent)', color: '#fff', fontSize: '11px', cursor: 'pointer' }}
                      >
                        Save setup
                      </button>
                    </div>

                    <div style={{ display: 'flex', gap: '10px', minHeight: '260px' }}>
                      {/* Left rail: launch config list */}
                      <div style={{
                        width: '140px',
                        flexShrink: 0,
                        border: '1px solid var(--border)',
                        borderRadius: '4px',
                        background: 'var(--bg-tertiary)',
                        padding: '4px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                      }}>
                        {launchConfigNames.map((name) => {
                          const isSelected = name === selectedLaunchConfig
                          const isRenaming = renamingLaunchConfig === name
                          return (
                            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                              {isRenaming ? (
                                <input
                                  autoFocus
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleRenameLaunchConfig(name)
                                    if (e.key === 'Escape') { setRenamingLaunchConfig(null); setRenameValue('') }
                                  }}
                                  onBlur={() => handleRenameLaunchConfig(name)}
                                  style={{
                                    flex: 1,
                                    padding: '4px 6px',
                                    fontSize: '11.5px',
                                    fontFamily: 'var(--font-mono)',
                                    border: '1px solid var(--accent)',
                                    borderRadius: '3px',
                                    background: 'var(--bg-primary)',
                                    color: 'var(--text-primary)',
                                    outline: 'none',
                                  }}
                                />
                              ) : (
                                <button
                                  onClick={() => setSelectedLaunchConfig(name)}
                                  onDoubleClick={() => {
                                    if (name === 'default') return
                                    setRenamingLaunchConfig(name)
                                    setRenameValue(name)
                                  }}
                                  title={name === 'default' ? 'default - implicit fallback (cannot rename / delete)' : 'Double-click to rename'}
                                  style={{
                                    flex: 1,
                                    textAlign: 'left',
                                    padding: '5px 8px',
                                    fontSize: '11.5px',
                                    fontFamily: 'var(--font-mono)',
                                    border: 'none',
                                    borderRadius: '3px',
                                    background: isSelected ? 'var(--accent-subtle)' : 'transparent',
                                    color: isSelected ? 'var(--accent)' : 'var(--text-primary)',
                                    cursor: 'pointer',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {name}
                                </button>
                              )}
                              {!isRenaming && name !== 'default' && (
                                <button
                                  onClick={async () => {
                                    if (await confirm({ title: `Delete launch config "${name}"?`, confirmLabel: 'Delete', destructive: true })) handleDeleteLaunchConfig(name)
                                  }}
                                  title="Delete launch config"
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--text-muted)',
                                    cursor: 'pointer',
                                    fontSize: '14px',
                                    lineHeight: 1,
                                    padding: '2px 4px',
                                  }}
                                >
                                  &times;
                                </button>
                              )}
                            </div>
                          )
                        })}

                        {addingLaunchConfig ? (
                          <input
                            autoFocus
                            value={addValue}
                            onChange={(e) => setAddValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleAddLaunchConfig()
                              if (e.key === 'Escape') { setAddingLaunchConfig(false); setAddValue('') }
                            }}
                            onBlur={handleAddLaunchConfig}
                            placeholder="launch config name"
                            style={{
                              padding: '5px 8px',
                              fontSize: '11.5px',
                              fontFamily: 'var(--font-mono)',
                              border: '1px solid var(--accent)',
                              borderRadius: '3px',
                              background: 'var(--bg-primary)',
                              color: 'var(--text-primary)',
                              outline: 'none',
                              marginTop: '2px',
                            }}
                          />
                        ) : (
                          <button
                            onClick={() => { setAddingLaunchConfig(true); setAddValue('') }}
                            style={{
                              marginTop: '2px',
                              padding: '5px 8px',
                              fontSize: '11px',
                              fontFamily: 'var(--font-mono)',
                              border: '1px dashed var(--border)',
                              borderRadius: '3px',
                              background: 'transparent',
                              color: 'var(--text-muted)',
                              cursor: 'pointer',
                              textAlign: 'left',
                            }}
                          >
                            + new launch config
                          </button>
                        )}
                      </div>

                      {/* Right pane: body editor */}
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <textarea
                          value={bodyYaml}
                          onChange={(e) => { setBodyYaml(e.target.value); setBodyDirty(true); setConfigSaveState('idle'); setConfigError(null) }}
                          spellCheck={false}
                          style={{
                            width: '100%',
                            flex: 1,
                            minHeight: '220px',
                            padding: '8px 10px',
                            borderRadius: '4px',
                            border: '1px solid var(--border)',
                            background: 'var(--bg-primary)',
                            color: 'var(--text-primary)',
                            fontSize: '12px',
                            fontFamily: 'var(--font-mono)',
                            lineHeight: 1.5,
                            resize: 'vertical',
                            outline: 'none',
                          }}
                        />
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginTop: '8px',
                          fontSize: '11px',
                          gap: '8px',
                        }}>
                          <span style={{ color: configError ? 'var(--error)' : 'var(--text-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={configError ?? undefined}>
                            {configError
                              ? configError
                              : configSaveState === 'saving' ? 'Saving…'
                              : configSaveState === 'saved' ? 'Saved'
                              : bodyDirty ? `Editing "${selectedLaunchConfig}" - unsaved`
                              : `Editing "${selectedLaunchConfig}"`}
                          </span>
                          <button
                            onClick={handleSaveBody}
                            disabled={!bodyDirty || configSaveState === 'saving'}
                            style={{
                              padding: '5px 14px',
                              borderRadius: '4px',
                              border: 'none',
                              background: bodyDirty ? 'var(--accent)' : 'var(--bg-tertiary)',
                              color: bodyDirty ? '#fff' : 'var(--text-muted)',
                              cursor: bodyDirty ? 'pointer' : 'default',
                              fontSize: '11.5px',
                              fontWeight: 500,
                              flexShrink: 0,
                            }}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </SettingsSection>
            </div>
          )}

          {activeTab === 'archived' && (
            <div>
              <SettingsSection title="Archived Conversations">
                {loadingArchived ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>
                ) : archived.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    No archived conversations. Archive a chat from the sidebar to see it here.
                  </div>
                ) : (
                  <>
                    <input
                      value={archivedQuery}
                      onChange={(e) => { setArchivedQuery(e.target.value); setArchivedPageNum(1) }}
                      placeholder={`Search ${archived.length} archived chat${archived.length === 1 ? '' : 's'} by title or project...`}
                      style={{
                        width: '100%',
                        marginBottom: '8px',
                        padding: '6px 8px',
                        border: '1px solid var(--border)',
                        borderRadius: '4px',
                        background: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        fontSize: '12px',
                        outline: 'none',
                      }}
                    />
                    {/* Above the list on purpose. A full page of rows is taller
                        than the modal, so a pager underneath them sits below the
                        fold and has to be scrolled to. */}
                    {archivedView.total > 0 && (
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        marginBottom: '8px',
                      }}>
                        <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                          Showing {archivedView.from} to {archivedView.to} of {archivedView.total}
                        </span>
                        {archivedView.pageCount > 1 && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <button
                              type="button"
                              onClick={() => setArchivedPageNum(archivedView.page - 1)}
                              disabled={archivedView.page <= 1}
                              style={pagerButtonStyle(archivedView.page <= 1)}
                            >
                              Previous
                            </button>
                            <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                              Page {archivedView.page} of {archivedView.pageCount}
                            </span>
                            <button
                              type="button"
                              onClick={() => setArchivedPageNum(archivedView.page + 1)}
                              disabled={archivedView.page >= archivedView.pageCount}
                              style={pagerButtonStyle(archivedView.page >= archivedView.pageCount)}
                            >
                              Next
                            </button>
                          </span>
                        )}
                      </div>
                    )}
                    {archivedView.total === 0 ? (
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '4px 0' }}>
                        No matches for "{archivedQuery.trim()}".
                      </div>
                    ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {archivedView.items.map((c) => (
                        <div
                          key={c.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px 10px',
                            borderRadius: 'var(--radius)',
                            background: 'var(--bg-tertiary)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: '12px',
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              fontWeight: 500,
                            }}>
                              {c.title}
                            </div>
                            <div style={{
                              fontSize: '10px',
                              color: 'var(--text-muted)',
                              fontFamily: 'var(--font-mono)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }} title={c.project_path}>
                              {c.project_path.split('/').slice(-2).join('/')}
                            </div>
                          </div>
                          <button
                            onClick={() => handleUnarchive(c)}
                            style={{
                              padding: '4px 10px',
                              borderRadius: '4px',
                              border: '1px solid var(--accent)',
                              background: 'var(--accent-subtle)',
                              color: 'var(--accent)',
                              cursor: 'pointer',
                              fontSize: '11px',
                              fontWeight: 500,
                              flexShrink: 0,
                            }}
                          >
                            Unarchive
                          </button>
                        </div>
                      ))}
                    </div>
                    )}
                  </>
                )}
              </SettingsSection>
            </div>
          )}

          {activeTab === 'tour' && (
            <TourTab onClose={onClose} />
          )}

          {activeTab === 'about' && (
            <div>
              <SettingsSection title="Switchboard">
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                  <div>A unified developer workspace that multiplexes terminals and agent chats.</div>
                  <div style={{ marginTop: '8px', color: 'var(--text-muted)', fontSize: '11px' }}>
                    Built with Electron + React + TypeScript + Love
                  </div>
                </div>
              </SettingsSection>
              <SettingsSection title="Updates">
                <UpdateCheckRow />
              </SettingsSection>
              <DiagnosticsSection />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function pagerButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '3px 9px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
    fontSize: '11px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        marginBottom: '10px',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function SettingsLabel({ label }: { label: string }) {
  return (
    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
      {label}
    </div>
  )
}

function ShortcutRow({ label, keys }: { label: string; keys: string }) {
  return (
    <>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <kbd style={{
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border)',
        borderRadius: '4px',
        padding: '2px 6px',
        fontSize: '11px',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)',
      }}>
        {keys}
      </kbd>
    </>
  )
}

/**
 * Recommended workspace mode in the per-thread checkout chooser.
 */
function DefaultEnvModeToggle() {
  const [mode, setMode] = useState<SessionEnvMode | null>(null)
  useEffect(() => {
    getDefaultSessionEnvMode().then(setMode)
  }, [])
  const onChange = async (next: SessionEnvMode) => {
    setMode(next)
    await setDefaultSessionEnvMode(next)
  }
  return (
    <div>
      <div style={{ fontSize: '12.5px', color: 'var(--text-primary)', marginBottom: '4px' }}>
        Recommended workspace
      </div>
      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
        Choose which option is highlighted first. You still choose for every new thread.
        <strong> Local</strong> runs the agent in the project root;
        <strong> New worktree</strong> creates a fresh git worktree off HEAD so parallel threads
        don't trample each other.
      </div>
      <select
        value={mode ?? 'local'}
        disabled={mode === null}
        onChange={(e) => onChange(e.target.value as SessionEnvMode)}
        style={{
          background: 'var(--bg-tertiary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          padding: '4px 8px',
          fontSize: '12px',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        <option value="local">Local (project root)</option>
        <option value="worktree">New worktree</option>
      </select>
    </div>
  )
}

/** Steer or Queue: what Enter does while the agent works. See `layout-store.followUpDefault`. */
function FollowUpDefaultSetting() {
  const value = useLayoutStore((s) => s.followUpDefault)
  const setValue = useLayoutStore((s) => s.setFollowUpDefault)
  return (
    <div style={{ marginTop: '16px' }}>
      <div style={{ fontSize: '12.5px', color: 'var(--text-primary)', marginBottom: '4px' }}>
        Follow-up while the agent works
      </div>
      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
        What Enter does with a message sent mid-turn. <strong>Steer</strong> hands it to the agent at its
        next step; <strong>Queue</strong> holds it until the turn ends. ⌥Enter does the other one.
        OpenCode always queues.
      </div>
      <select
        aria-label="Follow-up while the agent works"
        value={value}
        onChange={(event) => setValue(parseFollowUpDefault(event.target.value))}
        style={{
          background: 'var(--bg-tertiary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          padding: '4px 8px',
          fontSize: '12px',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        <option value="steer">Steer</option>
        <option value="queue">Queue</option>
      </select>
    </div>
  )
}

export function RecentConversationsSetting() {
  const [limit, setLimit] = useState<RecentSessionLimit>(DEFAULT_RECENT_SESSION_LIMIT)
  const selectedSinceLoadStarted = useRef(false)
  useEffect(() => {
    let cancelled = false
    window.api.settings.get(RECENT_SESSION_LIMIT_SETTING).then((value) => {
      const loaded = resolveLoadedRecentSessionLimit(value, selectedSinceLoadStarted.current)
      if (!cancelled && loaded !== null) setLimit(loaded)
    })
    return () => { cancelled = true }
  }, [])
  const onChange = async (next: RecentSessionLimit) => {
    selectedSinceLoadStarted.current = true
    setLimit(next)
    await window.api.settings.set(RECENT_SESSION_LIMIT_SETTING, String(next))
    window.dispatchEvent(new CustomEvent(RECENT_SESSION_LIMIT_CHANGED, { detail: next }))
  }
  return (
    <div style={{ marginTop: '16px' }}>
      <div style={{ fontSize: '12.5px', color: 'var(--text-primary)', marginBottom: '4px' }}>
        Recent conversations
      </div>
      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
        Rows shown before the Recents section offers Show more.
      </div>
      <select
        aria-label="Recent conversations"
        value={limit}
        onChange={(event) => void onChange(Number(event.target.value) as RecentSessionLimit)}
        style={{
          background: 'var(--bg-tertiary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          padding: '4px 8px',
          fontSize: '12px',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        {RECENT_SESSION_LIMITS.map((value) => (
          <option key={value} value={value}>{value} conversations</option>
        ))}
      </select>
    </div>
  )
}

/**
 * How long the embedded IDE (code-server) may sit hidden before Switchboard
 * kills it to reclaim CPU/RAM. Relaunch on next open is ~2s. Stored as
 * `ide.idleTtlMinutes`; IdePane re-reads on the `sb-ide-settings-changed`
 * event so a change applies without a restart.
 */
function IdeIdleTtlSetting() {
  const [minutes, setMinutes] = useState<string>('')
  useEffect(() => {
    window.api.settings.get('ide.idleTtlMinutes').then((v) => setMinutes(v ?? '5'))
  }, [])
  const onChange = async (raw: string) => {
    setMinutes(raw)
    const n = parseFloat(raw)
    if (!Number.isFinite(n) || n <= 0) return
    await window.api.settings.set('ide.idleTtlMinutes', String(n))
    window.dispatchEvent(new Event('sb-ide-settings-changed'))
  }
  return (
    <div>
      <div style={{ fontSize: '12.5px', color: 'var(--text-primary)', marginBottom: '4px' }}>
        Shut down when hidden after
      </div>
      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
        Idle minutes before the code-server workbench is killed to free CPU/RAM. Reopening (⌘⇧E) relaunches it in ~2s.
      </div>
      <input
        type="number"
        min={1}
        step={1}
        value={minutes}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'var(--bg-tertiary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          padding: '4px 8px',
          fontSize: '12px',
          width: '80px',
          outline: 'none',
        }}
      />
      <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '6px' }}>minutes</span>
    </div>
  )
}

/**
 * Toggle: stream assistant responses token-by-token (default ON) or
 * buffer until the turn completes and render the final reply in one
 * shot. The buffering policy lives in `streamingBuffer.ts`; the gate
 * is in ChatPanel's content / turn.completed handlers. Takes effect on
 * the next panel mount or session switch - flipping mid-turn doesn't
 * retroactively buffer in-flight content.
 */
function StreamAssistantToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    isAssistantStreamingEnabled().then(setEnabled)
  }, [])
  const toggle = async () => {
    const next = !enabled
    setEnabled(next)
    await setAssistantStreamingEnabled(next)
  }
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 0',
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={enabled === true}
        onChange={toggle}
        disabled={enabled === null}
        style={{ cursor: 'pointer' }}
      />
      <span>
        <div style={{ fontSize: '12.5px', color: 'var(--text-primary)' }}>
          Stream assistant messages
        </div>
        <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '2px' }}>
          Show token-by-token output while a response is in progress. Off renders the final
          reply in one shot when the turn completes.
        </div>
      </span>
    </label>
  )
}

/**
 * Toggle: render per-file diff cards inline in chat after a turn (default
 * off - most users review the diff via the PR, not in chat). Off collapses
 * a turn's changed files to a single button that expands them for that
 * turn only. Backed by `layout-store` (`chat.showFileDiffs`).
 */
function FileDiffCardsToggle() {
  const enabled = useLayoutStore((s) => s.showFileDiffCards)
  const setEnabled = useLayoutStore((s) => s.setShowFileDiffCards)
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 0',
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={() => setEnabled(!enabled)}
        style={{ cursor: 'pointer' }}
      />
      <span>
        <div style={{ fontSize: '12.5px', color: 'var(--text-primary)' }}>
          Show file diff cards in chat
        </div>
        <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '2px' }}>
          Show per-file diffs inline after each turn. Off shows a "Changed N files" button that
          expands them for that turn only.
        </div>
      </span>
    </label>
  )
}

/**
 * Toggle: anonymous usage counts (main/analytics.ts). Default on; the
 * main process reads the same setting before every event, so flipping
 * it here stops the next event without a restart.
 */
function AnalyticsToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    isAnalyticsEnabled().then(setEnabled)
  }, [])
  const toggle = async () => {
    const next = !enabled
    setEnabled(next)
    await setAnalyticsEnabled(next)
  }
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 0',
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={enabled === true}
        onChange={toggle}
        disabled={enabled === null}
        style={{ cursor: 'pointer' }}
      />
      <span>
        <div style={{ fontSize: '12.5px', color: 'var(--text-primary)' }}>
          Share anonymous usage counts
        </div>
        <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '2px' }}>
          Sends launch, session, tour and crash counts with the app version, platform, chip and a
          random install id, never a path, name or message; one click here turns it off.
        </div>
      </span>
    </label>
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
 * Toggle: fire a native OS notification when an agent finishes a turn
 * while the user isn't looking at that chat. Persisted to the same
 * settings table as theme.
 */
function NotificationToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => currentNotificationPermission())
  const [testResult, setTestResult] = useState<string | null>(null)

  useEffect(() => { areNotificationsEnabled().then(setEnabled) }, [])

  const toggle = async () => {
    const next = !enabled
    setEnabled(next)
    await setNotificationsEnabled(next)
    // Ask for permission when enabling (no-op if already granted/denied)
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        await Notification.requestPermission()
      } catch (err) {
        log.debug('Notification.requestPermission failed', err)
      }
      setPermission(currentNotificationPermission())
    }
  }

  const test = async () => {
    setTestResult('Firing…')
    const r = await fireTestNotification()
    setPermission(currentNotificationPermission())
    setTestResult(r.ok ? 'Sent - check Notification Center.' : (r.reason ?? 'Failed.'))
    setTimeout(() => setTestResult(null), 6000)
  }

  const permissionBadge = permission === 'granted'
    ? { text: 'Permission: granted', color: 'var(--success)' }
    : permission === 'denied'
      ? { text: 'Permission: denied (fix in macOS Settings)', color: 'var(--error)' }
      : permission === 'default'
        ? { text: 'Permission: not requested yet', color: 'var(--warning)' }
        : { text: 'Notification API unavailable', color: 'var(--text-muted)' }

  return (
    <div>
      <label style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 0',
        cursor: 'pointer',
      }}>
        <input
          type="checkbox"
          checked={enabled === true}
          onChange={toggle}
          disabled={enabled === null}
          style={{ cursor: 'pointer' }}
        />
        <span>
          <div style={{ fontSize: '12.5px', color: 'var(--text-primary)' }}>
            Notify when an agent finishes a turn
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Only fires when the app isn't focused or you're on a different chat.
          </div>
        </span>
      </label>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px', flexWrap: 'wrap' }}>
        <button
          onClick={test}
          disabled={enabled === false}
          style={{
            padding: '4px 10px',
            fontSize: '11.5px',
            borderRadius: '4px',
            border: '1px solid var(--border)',
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            cursor: enabled === false ? 'default' : 'pointer',
          }}
        >
          Send test notification
        </button>
        <span style={{ fontSize: '10.5px', color: permissionBadge.color }}>
          {permissionBadge.text}
        </span>
      </div>
      {testResult && (
        <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {testResult}
        </div>
      )}
    </div>
  )
}

/**
 * Settings → Tour tab. Replays the onboarding modal from the start, lets
 * the user jump to a specific clip, and toggles auto-open on update.
 *
 * The replay uses a window-level CustomEvent (`tour:replay`) so we don't
 * have to prop-drill state out of App. App listens and opens its
 * FeatureTourModal at the requested step.
 */
function TourTab({ onClose }: { onClose: () => void }) {
  const [autoplay, setAutoplay] = useState(true)

  useEffect(() => {
    window.api.settings.get('tour.autoplay').then((v) => {
      setAutoplay(v !== 'false')
    }).catch((err) => {
      log.debug('getting tour.autoplay setting failed - keeping default', err)
    })
  }, [])

  const toggleAutoplay = useCallback(async (next: boolean) => {
    setAutoplay(next)
    try {
      await window.api.settings.set('tour.autoplay', next ? 'true' : 'false')
    } catch (err) {
      log.warn('saving tour.autoplay setting failed', err)
    }
  }, [])

  const replay = useCallback((startAt = 0) => {
    onClose()
    window.dispatchEvent(new CustomEvent('tour:replay', { detail: { startAt } }))
  }, [onClose])

  return (
    <div>
      <SettingsSection title="Feature tour">
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '12px' }}>
          A short, replayable walk-through of what's shipped. Auto-opens on first launch
          after a release adds new features.
        </div>
        <button
          type="button"
          onClick={() => replay(0)}
          style={{
            padding: '7px 14px',
            background: 'var(--accent)',
            border: 'none',
            color: 'var(--bg)',
            borderRadius: '5px',
            fontSize: '12.5px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          ▶ Replay tour
        </button>
        <label style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginTop: '14px',
          fontSize: '12px',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={autoplay}
            onChange={(e) => void toggleAutoplay(e.target.checked)}
          />
          Auto-open the tour after a release adds new features
        </label>
      </SettingsSection>

      <SettingsSection title="Jump to a step">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {FEATURE_TOUR_STEPS.map((step, i) => (
            <button
              key={step.id}
              type="button"
              onClick={() => replay(i)}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '12px',
                padding: '8px 12px',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border)',
                borderRadius: '5px',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text-primary)',
              }}
            >
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                color: 'var(--text-muted)',
                minWidth: '20px',
              }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span style={{ fontSize: '12.5px', fontWeight: 500 }}>{step.title}</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>Play →</span>
            </button>
          ))}
        </div>
      </SettingsSection>
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
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setHelpOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
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
