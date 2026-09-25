import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  parseLaunchConfigFile,
  serializeLaunchConfigBody,
  parseLaunchConfigBodyYaml,
  type LaunchConfigFile,
  type WorktreeSetupConfig,
} from '@shared/launch-config'
import { launchConfigListReducer } from '../../services/launch-config-list-reducer'
import { saveLaunchConfigFor } from './launch-config-save'
import { confirm } from '../ui/confirm'
import { onEscapeFirst } from '../ui/escape-first'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:launch-configs')

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

interface LaunchConfigProjectRow {
  path: string
  name: string
}

/** Settings > Projects: each project's `.switchboard/launch-config.yaml`. */
export function LaunchConfigsPanel() {
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

  // Escape in a launch-config name field cancels that edit instead of
  // closing Settings.
  useEffect(() => {
    if (renamingLaunchConfig === null) return
    return onEscapeFirst(() => { setRenamingLaunchConfig(null); setRenameValue('') })
  }, [renamingLaunchConfig])
  useEffect(() => {
    if (!addingLaunchConfig) return
    return onEscapeFirst(() => { setAddingLaunchConfig(false); setAddValue('') })
  }, [addingLaunchConfig])

  // Load the project list once; the first project is selected by default.
  useEffect(() => {
    window.api.app.getProjects().then((rows: LaunchConfigProjectRow[]) => {
      setLaunchConfigProjectRows(rows ?? [])
      if (rows?.length && !selectedLaunchConfigProject) setSelectedLaunchConfigProject(rows[0].path)
    }).catch((err) => {
      log.warn('getProjects failed for launch configs tab', err)
    })
  }, [selectedLaunchConfigProject])

  // When selected project changes, load + parse its yaml
  useEffect(() => {
    if (!selectedLaunchConfigProject) return
    // A slower read for the previous project must not land after this one:
    // every save builds on launchConfigFile and writes to the selected project.
    let cancelled = false
    window.api.app.getLaunchConfig(selectedLaunchConfigProject).then((yaml: string | null) => {
      if (cancelled) return
      const text = yaml ?? DEFAULT_LAUNCH_CONFIG_YAML
      let parsed: LaunchConfigFile
      try {
        parsed = parseLaunchConfigFile(text)
      } catch (err) {
        log.warn('launch-config.yaml did not parse, editing an empty config', err)
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
    }).catch((err) => {
      if (cancelled) return
      log.warn('getLaunchConfig failed, editing an empty config', err)
      const fresh: LaunchConfigFile = { terminals: [], configs: { default: { terminals: [] } } }
      setLaunchConfigFile(fresh)
      setSelectedLaunchConfig('default')
      setBodyYaml(serializeLaunchConfigBody(fresh.configs!.default))
      setBodyDirty(false)
    })
    return () => { cancelled = true }
  }, [selectedLaunchConfigProject])

  // When the user picks a different launch config name, swap the body editor.
  useEffect(() => {
    const tpl = launchConfigFile.configs?.[selectedLaunchConfig]
    if (!tpl) return
    setBodyYaml(serializeLaunchConfigBody(tpl))
    setBodyDirty(false)
    setConfigError(null)
  }, [selectedLaunchConfig, launchConfigFile])

  const currentProject = useRef(selectedLaunchConfigProject)
  currentProject.current = selectedLaunchConfigProject

  /** True only when the write landed on the project still selected; callers stop otherwise. */
  const persist = useCallback(async (config: LaunchConfigFile): Promise<boolean> => {
    const project = selectedLaunchConfigProject
    if (!project) return false
    setConfigSaveState('saving')
    setConfigError(null)
    const outcome = await saveLaunchConfigFor(
      project,
      config,
      (p, text) => window.api.app.saveLaunchConfig(p, text),
      (p) => currentProject.current === p,
    )
    if (outcome.kind === 'stale') return false
    if (outcome.kind === 'failed') {
      log.warn('saving launch-config.yaml failed', outcome.error)
      setConfigSaveState('error')
      setConfigError(outcome.error)
      return false
    }
    setLaunchConfigFile(config)
    setConfigSaveState('saved')
    setTimeout(() => setConfigSaveState('idle'), 1500)
    return true
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
    if (await persist(result.config)) setBodyDirty(false)
  }, [bodyYaml, launchConfigFile, selectedLaunchConfig, persist])

  const handleAddLaunchConfig = useCallback(async () => {
    const name = addValue.trim()
    if (!name) { setAddingLaunchConfig(false); return }
    const result = launchConfigListReducer(launchConfigFile, { type: 'addLaunchConfig', name })
    if (!result.ok) {
      setConfigError(result.error)
      return
    }
    if (!(await persist(result.config))) return
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
    if (!(await persist(result.config))) return
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
    if (!(await persist(result.config))) return
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

  return (
    <>
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
    </>
  )
}
