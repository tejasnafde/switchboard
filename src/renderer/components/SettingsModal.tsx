import { useState, useEffect, useCallback, useMemo } from 'react'
import { useThemeStore, type ThemeName } from '../stores/theme-store'
import { emitSessionRename } from '../services/session-events'
import { FEATURE_TOUR_STEPS } from './onboarding/featureRegistry'
import type { UpdateStatus } from '@shared/update-status'
import {
  parseWorkspaceConfig,
  serializeWorkspaceConfig,
  serializeTemplateBody,
  parseTemplateBodyYaml,
  type WorkspaceConfig,
} from '@shared/workspace-config'
import { templateListReducer } from '../services/templateListReducer'
import {
  areNotificationsEnabled,
  setNotificationsEnabled,
  fireTestNotification,
  currentNotificationPermission,
} from '../services/notifications'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const THEMES: { value: ThemeName; label: string; desc: string }[] = [
  { value: 'dark', label: 'Dark', desc: 'Default dark interface' },
  { value: 'light', label: 'Light', desc: 'Clean light interface' },
  { value: 'translucent', label: 'Translucent', desc: 'Blurred desktop vibrancy (macOS)' },
]

interface ArchivedConv {
  id: string
  project_path: string
  title: string
  updated_at: number
}

const DEFAULT_WORKSPACE_YAML = `# Terminals to spawn when a chat in this project is opened.
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

interface WorkspaceProject {
  path: string
  name: string
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { theme, setTheme } = useThemeStore()
  const [activeTab, setActiveTab] = useState<'general' | 'providers' | 'workspaces' | 'archived' | 'tour' | 'about'>('general')
  const [archived, setArchived] = useState<ArchivedConv[]>([])
  const [loadingArchived, setLoadingArchived] = useState(false)
  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProject[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null)
  // Parsed config drives the template list. The body editor is a per-template
  // YAML buffer; on save we feed it back into the reducer + serialize.
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig>({ terminals: [], templates: { default: { terminals: [] } } })
  const [selectedTemplate, setSelectedTemplate] = useState<string>('default')
  const [bodyYaml, setBodyYaml] = useState('')
  const [bodyDirty, setBodyDirty] = useState(false)
  const [workspaceSaveState, setWorkspaceSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [renamingTemplate, setRenamingTemplate] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [addingTemplate, setAddingTemplate] = useState(false)
  const [addValue, setAddValue] = useState('')

  const loadArchived = useCallback(async () => {
    setLoadingArchived(true)
    try {
      const rows = await window.api.app.getArchivedConversations()
      setArchived(rows ?? [])
    } catch {
      setArchived([])
    } finally {
      setLoadingArchived(false)
    }
  }, [])

  useEffect(() => {
    if (open && activeTab === 'archived') loadArchived()
  }, [open, activeTab, loadArchived])

  // Workspaces tab — load project list once
  useEffect(() => {
    if (!open || activeTab !== 'workspaces') return
    window.api.app.getProjects().then((rows: WorkspaceProject[]) => {
      setWorkspaceProjects(rows ?? [])
      if (rows?.length && !selectedWorkspace) setSelectedWorkspace(rows[0].path)
    }).catch(() => {})
  }, [open, activeTab, selectedWorkspace])

  // When selected project changes, load + parse its yaml
  useEffect(() => {
    if (!selectedWorkspace) return
    window.api.app.getWorkspaceConfig(selectedWorkspace).then((yaml: string | null) => {
      const text = yaml ?? DEFAULT_WORKSPACE_YAML
      let parsed: WorkspaceConfig
      try {
        parsed = parseWorkspaceConfig(text)
      } catch {
        parsed = { terminals: [], templates: { default: { terminals: [] } } }
      }
      // Ensure `default` always exists — the reducer + lifecycle assume it.
      if (!parsed.templates || !parsed.templates.default) {
        parsed = {
          ...parsed,
          templates: { default: { terminals: parsed.terminals ?? [], rows: parsed.rows }, ...(parsed.templates ?? {}) },
        }
      }
      setWorkspaceConfig(parsed)
      setSelectedTemplate('default')
      setBodyYaml(serializeTemplateBody(parsed.templates!.default))
      setBodyDirty(false)
      setWorkspaceSaveState('idle')
      setWorkspaceError(null)
    }).catch(() => {
      const fresh: WorkspaceConfig = { terminals: [], templates: { default: { terminals: [] } } }
      setWorkspaceConfig(fresh)
      setSelectedTemplate('default')
      setBodyYaml(serializeTemplateBody(fresh.templates!.default))
      setBodyDirty(false)
    })
  }, [selectedWorkspace])

  // When the user picks a different template name, swap the body editor.
  useEffect(() => {
    const tpl = workspaceConfig.templates?.[selectedTemplate]
    if (!tpl) return
    setBodyYaml(serializeTemplateBody(tpl))
    setBodyDirty(false)
    setWorkspaceError(null)
  }, [selectedTemplate, workspaceConfig])

  const persist = useCallback(async (config: WorkspaceConfig) => {
    if (!selectedWorkspace) return
    setWorkspaceSaveState('saving')
    setWorkspaceError(null)
    try {
      const text = serializeWorkspaceConfig(config)
      await window.api.app.saveWorkspaceConfig(selectedWorkspace, text)
      setWorkspaceConfig(config)
      setWorkspaceSaveState('saved')
      setTimeout(() => setWorkspaceSaveState('idle'), 1500)
    } catch (e) {
      setWorkspaceSaveState('error')
      setWorkspaceError(e instanceof Error ? e.message : String(e))
    }
  }, [selectedWorkspace])

  const handleSaveBody = useCallback(async () => {
    let body
    try {
      body = parseTemplateBodyYaml(bodyYaml)
    } catch (e) {
      setWorkspaceError(e instanceof Error ? e.message : 'Invalid YAML')
      setWorkspaceSaveState('error')
      return
    }
    if (!body) {
      setWorkspaceError('Template body must define `terminals:` or `rows:`.')
      setWorkspaceSaveState('error')
      return
    }
    const result = templateListReducer(workspaceConfig, { type: 'replaceTemplateBody', name: selectedTemplate, body })
    if (!result.ok) {
      setWorkspaceError(result.error)
      setWorkspaceSaveState('error')
      return
    }
    await persist(result.config)
    setBodyDirty(false)
  }, [bodyYaml, workspaceConfig, selectedTemplate, persist])

  const handleAddTemplate = useCallback(async () => {
    const name = addValue.trim()
    if (!name) { setAddingTemplate(false); return }
    const result = templateListReducer(workspaceConfig, { type: 'addTemplate', name })
    if (!result.ok) {
      setWorkspaceError(result.error)
      return
    }
    await persist(result.config)
    setSelectedTemplate(name)
    setAddingTemplate(false)
    setAddValue('')
  }, [addValue, workspaceConfig, persist])

  const handleRenameTemplate = useCallback(async (from: string) => {
    const to = renameValue.trim()
    if (!to || to === from) { setRenamingTemplate(null); return }
    const result = templateListReducer(workspaceConfig, { type: 'renameTemplate', from, to })
    if (!result.ok) {
      setWorkspaceError(result.error)
      return
    }
    await persist(result.config)
    if (selectedTemplate === from) setSelectedTemplate(to)
    setRenamingTemplate(null)
    setRenameValue('')
  }, [renameValue, workspaceConfig, selectedTemplate, persist])

  const handleDeleteTemplate = useCallback(async (name: string) => {
    const result = templateListReducer(workspaceConfig, { type: 'deleteTemplate', name })
    if (!result.ok) {
      setWorkspaceError(result.error)
      return
    }
    await persist(result.config)
    if (selectedTemplate === name) setSelectedTemplate('default')
  }, [workspaceConfig, selectedTemplate, persist])

  const templateNames = useMemo(() => {
    const names = Object.keys(workspaceConfig.templates ?? {})
    return names.sort((a, b) => {
      if (a === 'default') return -1
      if (b === 'default') return 1
      return a.localeCompare(b)
    })
  }, [workspaceConfig])

  const handleUnarchive = useCallback(async (conv: ArchivedConv) => {
    setArchived((prev) => prev.filter((c) => c.id !== conv.id))
    try {
      await window.api.app.unarchiveConversation(conv.id)
      // Trigger sidebar refresh via rename event (same title — just to nudge the list)
      emitSessionRename(conv.id, conv.title)
      // Also dispatch a generic event to prompt project reload
      window.dispatchEvent(new CustomEvent('sidebar-refresh'))
    } catch {
      // Rollback
      setArchived((prev) => [...prev, conv])
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
          {(['general', 'providers', 'workspaces', 'archived', 'tour', 'about'] as const).map((tab) => (
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
              {tab}
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

              {/* Keyboard shortcuts info */}
              <SettingsSection title="Keyboard Shortcuts">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 16px', fontSize: '12px' }}>
                  <ShortcutRow label="Toggle sidebar" keys={'\u2318B'} />
                  <ShortcutRow label="Toggle terminal" keys={'\u2318J'} />
                  <ShortcutRow label="Command palette" keys={'\u2318\u21E7P'} />
                  <ShortcutRow label="Search across chats" keys={'\u2318\u21E7F'} />
                  <ShortcutRow label="Open settings" keys={'\u2318,'} />
                  <ShortcutRow label="Send message" keys="Enter" />
                  <ShortcutRow label="New line in message" keys="Shift+Enter" />
                  <ShortcutRow label="Stop agent (when running)" keys={'\u2318\u232B'} />
                  <ShortcutRow label="Quick prompt (Spotlight-style)" keys={'\u2318K'} />
                  <ShortcutRow label="Send terminal selection to chat" keys={'\u2318L'} />
                  <ShortcutRow label="Toggle dual-chat panel" keys={'\u2318\u21E7\\'} />

                  {/* Terminals */}
                  <ShortcutRow label="New window (right)" keys={'\u2318T'} />
                  <ShortcutRow label="New window (below)" keys={'\u2318\u21E7T'} />
                  <ShortcutRow label="New tab in active window" keys={'\u2318\\'} />
                  <ShortcutRow label="Close active tab" keys={'\u2318W'} />
                  <ShortcutRow label="Close active window" keys={'\u2318\u21E7W'} />
                  <ShortcutRow label="Next tab" keys={'\u2318\u21E7]'} />
                  <ShortcutRow label="Prev tab" keys={'\u2318\u21E7['} />
                  <ShortcutRow label="Focus window N" keys={'\u23181…9'} />
                  <ShortcutRow label="Navigate windows" keys={'\u2318\u2325\u2190\u2191\u2193\u2192'} />
                </div>
              </SettingsSection>
            </div>
          )}

          {activeTab === 'providers' && (
            <div>
              <SettingsSection title="Claude Code">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{
                    width: '8px', height: '8px', borderRadius: '50%',
                    background: 'var(--success)',
                  }} />
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Available</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Ensure the Claude Code CLI is installed and authenticated.
                </div>
              </SettingsSection>

              <SettingsSection title="Codex (OpenAI)">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{
                    width: '8px', height: '8px', borderRadius: '50%',
                    background: 'var(--success)',
                  }} />
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Available</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Ensure the <code style={{ fontFamily: 'var(--font-mono)' }}>codex</code> CLI is installed — Switchboard spawns it via <code style={{ fontFamily: 'var(--font-mono)' }}>codex app-server</code>.
                </div>
              </SettingsSection>

              <SettingsSection title="OpenCode — API Keys">
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px', lineHeight: 1.6 }}>
                  Keys are stored in Switchboard's settings DB and injected into OpenCode's spawn env
                  on each turn. They override anything exported in your shell. Referenced from
                  <code style={{ fontFamily: 'var(--font-mono)', margin: '0 3px' }}>~/.config/opencode/opencode.json</code>
                  via <code style={{ fontFamily: 'var(--font-mono)' }}>{'{env:VAR_NAME}'}</code>.
                </div>
                <ApiKeyField envVar="NVIDIA_API_KEY" label="NVIDIA NIM" hint="Free tier at build.nvidia.com" />
                <ApiKeyField envVar="GEMINI_API_KEY" label="Google Gemini" hint="aistudio.google.com/apikey" />
                <ApiKeyField envVar="ANTHROPIC_API_KEY" label="Anthropic" hint="Used if you route Claude via OpenCode" />
                <ApiKeyField envVar="OPENAI_API_KEY" label="OpenAI" hint="For gpt-4o / o1 via OpenCode" />
                <ApiKeyField envVar="GROQ_API_KEY" label="Groq" hint="console.groq.com" />
                <ApiKeyField envVar="OPENROUTER_API_KEY" label="OpenRouter" hint="openrouter.ai/keys" />
              </SettingsSection>

              <SettingsSection title="Runtime Modes">
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  <div><b style={{ color: 'var(--text-secondary)' }}>Sandbox</b> — agent asks for every tool call.</div>
                  <div><b style={{ color: 'var(--text-secondary)' }}>Accept Edits</b> — file edits auto-approved, shell/other still prompt.</div>
                  <div><b style={{ color: 'var(--text-secondary)' }}>Full Access</b> — no prompts; use with care.</div>
                  <div><b style={{ color: 'var(--text-secondary)' }}>Plan Only</b> — agent produces a plan without executing anything.</div>
                </div>
              </SettingsSection>
            </div>
          )}

          {activeTab === 'workspaces' && (
            <div>
              <SettingsSection title="Project Workspace Templates">
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px', lineHeight: 1.6 }}>
                  Each project defines named terminal templates in <code style={{ fontFamily: 'var(--font-mono)' }}>&lt;project&gt;/.switchboard/workspace.yaml</code>.
                  New chats start from the <code style={{ fontFamily: 'var(--font-mono)' }}>default</code> template;
                  switch templates per chat from the terminal strip header.
                </div>

                {workspaceProjects.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    No projects added yet. Click "+ Add Project" in the sidebar first.
                  </div>
                ) : (
                  <>
                    <select
                      value={selectedWorkspace ?? ''}
                      onChange={(e) => setSelectedWorkspace(e.target.value)}
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
                      {workspaceProjects.map((p) => (
                        <option key={p.path} value={p.path}>{p.name}</option>
                      ))}
                    </select>

                    <div style={{ display: 'flex', gap: '10px', minHeight: '260px' }}>
                      {/* Left rail: template list */}
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
                        {templateNames.map((name) => {
                          const isSelected = name === selectedTemplate
                          const isRenaming = renamingTemplate === name
                          return (
                            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                              {isRenaming ? (
                                <input
                                  autoFocus
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleRenameTemplate(name)
                                    if (e.key === 'Escape') { setRenamingTemplate(null); setRenameValue('') }
                                  }}
                                  onBlur={() => handleRenameTemplate(name)}
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
                                  onClick={() => setSelectedTemplate(name)}
                                  onDoubleClick={() => {
                                    if (name === 'default') return
                                    setRenamingTemplate(name)
                                    setRenameValue(name)
                                  }}
                                  title={name === 'default' ? 'default \u2014 implicit fallback (cannot rename / delete)' : 'Double-click to rename'}
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
                                  onClick={() => {
                                    if (confirm(`Delete template "${name}"?`)) handleDeleteTemplate(name)
                                  }}
                                  title="Delete template"
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

                        {addingTemplate ? (
                          <input
                            autoFocus
                            value={addValue}
                            onChange={(e) => setAddValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleAddTemplate()
                              if (e.key === 'Escape') { setAddingTemplate(false); setAddValue('') }
                            }}
                            onBlur={handleAddTemplate}
                            placeholder="template name"
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
                            onClick={() => { setAddingTemplate(true); setAddValue('') }}
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
                            + new template
                          </button>
                        )}
                      </div>

                      {/* Right pane: body editor */}
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <textarea
                          value={bodyYaml}
                          onChange={(e) => { setBodyYaml(e.target.value); setBodyDirty(true); setWorkspaceSaveState('idle'); setWorkspaceError(null) }}
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
                          <span style={{ color: workspaceError ? 'var(--error)' : 'var(--text-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={workspaceError ?? undefined}>
                            {workspaceError
                              ? workspaceError
                              : workspaceSaveState === 'saving' ? 'Saving\u2026'
                              : workspaceSaveState === 'saved' ? 'Saved'
                              : bodyDirty ? `Editing "${selectedTemplate}" \u2014 unsaved`
                              : `Editing "${selectedTemplate}"`}
                          </span>
                          <button
                            onClick={handleSaveBody}
                            disabled={!bodyDirty || workspaceSaveState === 'saving'}
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {archived.map((c) => (
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
            </div>
          )}
        </div>
      </div>
    </div>
  )
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
      try { await Notification.requestPermission() } catch { /* ignore */ }
      setPermission(currentNotificationPermission())
    }
  }

  const test = async () => {
    setTestResult('Firing…')
    const r = await fireTestNotification()
    setPermission(currentNotificationPermission())
    setTestResult(r.ok ? 'Sent — check Notification Center.' : (r.reason ?? 'Failed.'))
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
 * Persists an API key to the settings DB under `opencode.env.<ENV_VAR>`.
 * Masks the stored value in the input so users don't accidentally expose
 * it on screen; "Show" toggles plaintext for verification/editing.
 *
 * Saves debounced on blur + on explicit Save click. Load on mount.
 */
function ApiKeyField({ envVar, label, hint }: { envVar: string; label: string; hint?: string }) {
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle')
  const storageKey = `opencode.env.${envVar}`

  useEffect(() => {
    window.api.settings.get(storageKey).then((v: string | null) => {
      if (typeof v === 'string') setValue(v)
    }).catch(() => {})
  }, [storageKey])

  const save = useCallback(async (next: string) => {
    try {
      if (next.length === 0) {
        await window.api.settings.remove(storageKey)
      } else {
        await window.api.settings.set(storageKey, next)
      }
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 1200)
    } catch { /* ignore */ }
  }, [storageKey])

  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '3px' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
          {label} <code style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-muted)' }}>{envVar}</code>
        </span>
        {saveState === 'saved' && (
          <span style={{ fontSize: '10px', color: 'var(--success)' }}>saved</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: '6px' }}>
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => save(value)}
          placeholder={`${envVar}=...`}
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: 1,
            padding: '6px 8px',
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            background: 'var(--bg-input, var(--bg-secondary))',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            color: 'var(--text)',
          }}
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          style={{
            padding: '4px 8px',
            fontSize: '11px',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            color: 'var(--text-muted)',
            cursor: 'pointer',
          }}
        >
          {reveal ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint && (
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px' }}>{hint}</div>
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
    }).catch(() => {})
  }, [])

  const toggleAutoplay = useCallback(async (next: boolean) => {
    setAutoplay(next)
    try { await window.api.settings.set('tour.autoplay', next ? 'true' : 'false') } catch { /* ignore */ }
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
 * updates" button that bypasses the launch-time auto-check, and —
 * once an update has been downloaded — a "Restart and install"
 * button. In dev (non-packaged) builds the row reports the
 * "unsupported" status since electron-updater has nothing to compare
 * against.
 */
function UpdateCheckRow() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)

  // Subscribe to live status events from main. Coexists with the
  // launch-time auto-check, so by the time this mounts there may
  // already be a `checking` or `up-to-date` event in flight; we'll
  // pick up the next one.
  useEffect(() => {
    const api = window.api.app as unknown as {
      onUpdateStatus: (cb: (s: UpdateStatus) => void) => () => void
    }
    return api.onUpdateStatus(setStatus)
  }, [])

  const check = useCallback(async () => {
    setBusy(true)
    try {
      const api = window.api.app as unknown as {
        checkForUpdates: () => Promise<UpdateStatus>
      }
      const result = await api.checkForUpdates()
      setStatus(result)
    } finally {
      setBusy(false)
    }
  }, [])

  const restart = useCallback(() => {
    const api = window.api.app as unknown as { quitAndInstall: () => void }
    api.quitAndInstall()
  }, [])

  const label = (() => {
    switch (status.kind) {
      case 'idle': return 'Idle.'
      case 'checking': return 'Checking…'
      case 'up-to-date': return `You're on the latest version (${status.version}).`
      case 'available': return `Update available — downloading ${status.version}…`
      case 'downloading': return `Downloading… ${status.percent}%`
      case 'downloaded': return `Update ready: ${status.version}. Restart to install.`
      case 'error': return `Couldn't check: ${status.message}`
      case 'unsupported': return status.reason
    }
  })()

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
          disabled={busy || status.kind === 'checking' || status.kind === 'downloading'}
          style={{
            padding: '6px 14px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)',
            borderRadius: '5px',
            color: 'var(--text-primary)',
            fontSize: '12px',
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          Check for updates
        </button>
        {status.kind === 'downloaded' && (
          <button
            type="button"
            onClick={restart}
            style={{
              padding: '6px 14px',
              background: 'var(--accent)',
              border: '1px solid var(--accent)',
              borderRadius: '5px',
              color: 'var(--bg)',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Restart and install
          </button>
        )}
      </div>
      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Updates are checked automatically when the app launches. Builds are unsigned —
        on macOS, Gatekeeper may re-quarantine each version (right-click → Open, or run{' '}
        <code style={{ fontFamily: 'var(--font-mono)' }}>
          xattr -dr com.apple.quarantine /Applications/Switchboard.app
        </code>
        ). On Windows, click "More info → Run anyway" the first time only.
      </div>
    </div>
  )
}

