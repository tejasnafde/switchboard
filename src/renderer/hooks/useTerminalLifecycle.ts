import { useEffect, useRef } from 'react'
import { useAgentStore } from '../stores/agent-store'
import { useTerminalStore } from '../stores/terminal-store'
import { parseLaunchConfigFile, serializeLaunchConfigFile, type LaunchConfig, type LaunchConfigFile } from '@shared/launch-config'
import { planLaunchConfigSpawn, resolveLaunchConfigFallback, resolveCwd, type SpawnOp } from '../services/launchConfigPlanner'
import { recordLaunchConfigUsage } from '../services/launchConfigUsage'
import { getRecentOutputPaneLabels } from '../services/terminal-registry'
import { launchConfigListReducer } from '../services/launchConfigListReducer'

/**
 * Manages terminal lifecycle tied to agent sessions.
 *
 * Model: Session → Rows → Windows (columns) → Panes (tabs inside a window).
 *
 * - No terminals on cold start (empty state)
 * - When a session is activated the FIRST time: load layout from SQLite →
 *   launch-config.yaml → default (single window with one pane)
 * - When switching sessions: PTYs STAY ALIVE - we just show/hide based on active session
 * - PTYs only killed when: user closes a pane or session is deleted
 *
 * launch-config.yaml mapping (v0.1.20+):
 *   - Launch configs live under `configs: { default: { ... }, backend: { ... } }`
 *     in launch-config.yaml. The legacy top-level `terminals:` / `rows:` keys
 *     materialize as `configs.default` for back-compat.
 *   - Each session records which launch config name it hydrated from in
 *     `session_layouts.launch_config_name` so the picker chip + hot-reload
 *     know what's active.
 */
export function useTerminalLifecycle() {
  const hydratedSessionsRef = useRef<Set<string>>(new Set())
  const activeSessionId = useAgentStore((s) => s.activeSessionId)

  useEffect(() => {
    if (!activeSessionId) return

    if (hydratedSessionsRef.current.has(activeSessionId)) return

    const existing = useTerminalStore.getState().getLayout(activeSessionId)
    if (existing.rows.length > 0) {
      hydratedSessionsRef.current.add(activeSessionId)
      return
    }

    hydratedSessionsRef.current.add(activeSessionId)

    const session = useAgentStore.getState().sessions.find((s) => s.id === activeSessionId)
    if (!session) return

    // Worktree-backed sessions get terminals in the worktree, matching the
    // agent's cwd - not the shared parent checkout.
    spawnTerminalsForSession(activeSessionId, session.worktreePath ?? session.projectPath)
  }, [activeSessionId])

  // Watch for launch-config.yaml changes to hot-reload
  useEffect(() => {
    if (!window.api.app.onLaunchConfigChanged) return
    const cleanup = window.api.app.onLaunchConfigChanged((projectPath) => {
      const activeId = useAgentStore.getState().activeSessionId
      if (!activeId) return

      const session = useAgentStore.getState().sessions.find((s) => s.id === activeId)
      if (session && session.projectPath === projectPath) {
        // Capture the session's current launch config name BEFORE clearing
        // so the respawn can ask for the same one - the resolver will
        // fall back to default if the user just deleted it from YAML.
        const currentLaunchConfig = useTerminalStore.getState().getSessionLaunchConfigName(activeId)
        useTerminalStore.getState().clearSessionLayout(activeId)
        spawnTerminalsForSession(activeId, projectPath, true, currentLaunchConfig)
      }
    })
    return cleanup
  }, [])

  // Persist layouts every 30s (so relaunch restores state)
  useEffect(() => {
    const interval = setInterval(() => {
      const { layouts } = useTerminalStore.getState()
      for (const [sessionId, layout] of Object.entries(layouts)) {
        if (layout.rows.length === 0) continue
        const layoutData = {
          rows: layout.rows.map((row) => ({
            windows: row.windowIds.map((wid) => {
              const win = layout.windows[wid]
              return {
                panes: win.paneIds.map((pid) => {
                  const pane = layout.panes[pid]
                  return {
                    label: pane?.label ?? 'Terminal',
                    cwd: pane?.cwd,
                    command: pane?.command,
                  }
                }),
              }
            }),
          })),
        }
        const launchConfigName = useTerminalStore.getState().getSessionLaunchConfigName?.(sessionId) ?? null
        window.api.app.saveSessionLayout(sessionId, JSON.stringify(layoutData), launchConfigName).catch(() => {})
      }
    }, 30000)

    return () => clearInterval(interval)
  }, [])
}

// ─── Hydration helpers ──────────────────────────────────────────────

interface SavedPane { label?: string; cwd?: string; command?: string; wait_for?: string }
interface SavedWindow { panes?: SavedPane[] }
interface SavedRow { windows?: SavedWindow[]; panes?: SavedPane[] /* legacy */ }

async function spawnTerminalsForSession(
  sessionId: string,
  projectPath?: string,
  forceLaunchConfigFile = false,
  requestedLaunchConfig: string | null = null,
) {
  const store = useTerminalStore.getState()

  // 1. Try SQLite - restore the prior live layout exactly. Picker
  //    badge gets the saved launch_config_name back so the user sees the
  //    name they chose last session.
  if (!forceLaunchConfigFile) {
    try {
      const saved = await window.api.app.getSessionLayout(sessionId)
      if (saved && saved.layoutJson) {
        const parsed = JSON.parse(saved.layoutJson) as { rows?: SavedRow[] }
        if (parsed.rows && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
          restoreFromSaved(sessionId, parsed.rows, projectPath)
          if (saved.launchConfigName) useTerminalStore.getState().setSessionLaunchConfigName(sessionId, saved.launchConfigName)
          return
        }
      }
    } catch { /* fall through */ }
  }

  // 2. Try launch-config.yaml - hydrate from named launch config (or default).
  if (projectPath) {
    try {
      const yamlContent = await window.api.app.getLaunchConfig(projectPath)
      if (yamlContent) {
        const config = parseLaunchConfigFile(yamlContent)
        const resolved = resolveLaunchConfigFallback(config, requestedLaunchConfig)
        if (resolved) {
          if (resolved.fellBack && resolved.removedName) {
            window.dispatchEvent(new CustomEvent('sb-launch-config-fallback', {
              detail: { sessionId, removedName: resolved.removedName, fallbackName: resolved.launchConfigName },
            }))
          }
          spawnFromLaunchConfig(sessionId, resolved.launchConfig, projectPath)
          useTerminalStore.getState().setSessionLaunchConfigName(sessionId, resolved.launchConfigName)
          return
        }
      }
    } catch { /* fall through */ }
  }

  // 3. Default: one window, one pane
  const cwd = projectPath || undefined
  store.addWindow(sessionId, { label: 'Terminal 1', cwd })
}

function restoreFromSaved(sessionId: string, rows: SavedRow[], projectPath?: string) {
  const store = useTerminalStore.getState()
  let firstWindow = true

  for (const row of rows) {
    // New format: row.windows[] with each window having panes[]
    // Legacy format: row.panes[] (single pane per window)
    const windows: SavedWindow[] = row.windows
      ? row.windows
      : (row.panes ?? []).map((p) => ({ panes: [p] }))

    for (let wi = 0; wi < windows.length; wi++) {
      const win = windows[wi]
      const panes = win.panes ?? []
      if (panes.length === 0) continue

      const first = panes[0]
      // `stale: true` - panes restored from the previous session start in
      // a paused state. TerminalPane renders a "Start terminal" overlay
      // instead of silently respawning long-running commands (e.g. dev
      // servers) on every app launch.
      const commonOpts = (p: SavedPane) => ({
        label: p.label || 'Terminal',
        cwd: resolveCwd(p.cwd, projectPath),
        command: p.command,
        wait_for: p.wait_for,
        stale: true,
      })

      let windowRef: { windowId: string; paneId: string } | null
      if (firstWindow) {
        windowRef = store.addWindow(sessionId, commonOpts(first))
        firstWindow = false
      } else if (wi === 0) {
        // New row - split down
        windowRef = store.splitActiveWindow(sessionId, 'column', commonOpts(first))
      } else {
        // Same row - split right
        windowRef = store.splitActiveWindow(sessionId, 'row', commonOpts(first))
      }

      // Additional panes in this window become tabs
      if (windowRef) {
        for (let i = 1; i < panes.length; i++) {
          store.addPaneToWindow(sessionId, windowRef.windowId, {
            label: panes[i].label || `Terminal ${i + 1}`,
            cwd: resolveCwd(panes[i].cwd, projectPath),
            command: panes[i].command,
            wait_for: panes[i].wait_for,
            stale: true,
          })
        }
      }
    }
  }
}

/**
 * Walk a planner op list and dispatch each op to the terminal store.
 * Pure top-of-store - no PTY work happens here, just layout shape.
 */
function spawnFromLaunchConfig(sessionId: string, launchConfig: LaunchConfig, projectPath: string) {
  const store = useTerminalStore.getState()
  const ops: SpawnOp[] = planLaunchConfigSpawn(launchConfig, projectPath)
  for (const op of ops) {
    if (op.kind === 'addWindow') {
      store.addWindow(sessionId, op.opts)
    } else if (op.kind === 'splitColumn') {
      store.splitActiveWindow(sessionId, 'column', op.opts)
    } else {
      store.splitActiveWindow(sessionId, 'row', op.opts)
    }
  }
}

// ─── Public: switch the active launch config for a session ──────────────

/**
 * Tear down the session's current panes and re-hydrate from a named
 * launch config. Called by the per-chat picker chip in the terminal strip
 * header. If the requested launch config doesn't exist (race with a save
 * that just deleted it), falls back to `default` and dispatches the
 * `sb-launch-config-fallback` event so the UI can toast.
 */
export async function applyLaunchConfig(
  sessionId: string,
  launchConfigName: string,
  projectPath: string,
  options: { skipDirtyCheck?: boolean } = {},
): Promise<void> {
  const yamlContent = await window.api.app.getLaunchConfig(projectPath)
  if (!yamlContent) return
  const config = parseLaunchConfigFile(yamlContent)
  const resolved = resolveLaunchConfigFallback(config, launchConfigName)
  if (!resolved) return

  // Dirty-pane check: warn if any pane in this session has produced output
  // recently. Switching configs tears down all panes, so the user is
  // about to kill anything running (dev server, REPL, ssh session).
  if (!options.skipDirtyCheck) {
    const layout = useTerminalStore.getState().getLayout(sessionId)
    const paneIds = Object.keys(layout.panes)
    const hot = getRecentOutputPaneLabels(paneIds, layout.panes)
    if (hot.length > 0) {
      const list = hot.map((l) => `  • ${l}`).join('\n')
      const ok = window.confirm(
        `Switch to launch config "${resolved.launchConfigName}"?\n\n` +
        `These panes have produced output in the last 30s and will be killed:\n${list}\n\n` +
        `Press OK to switch anyway.`,
      )
      if (!ok) return
    }
  }

  const store = useTerminalStore.getState()
  store.clearSessionLayout(sessionId)
  spawnFromLaunchConfig(sessionId, resolved.launchConfig, projectPath)
  useTerminalStore.getState().setSessionLaunchConfigName(sessionId, resolved.launchConfigName)
  recordLaunchConfigUsage(projectPath, resolved.launchConfigName)

  if (resolved.fellBack && resolved.removedName) {
    window.dispatchEvent(new CustomEvent('sb-launch-config-fallback', {
      detail: { sessionId, removedName: resolved.removedName, fallbackName: resolved.launchConfigName },
    }))
  }

  // Persist immediately so a relaunch picks up the new selection.
  void window.api.app.saveSessionLayout(sessionId, snapshotLayoutJson(sessionId), resolved.launchConfigName).catch(() => {})
}

/**
 * Clear the launch config pin on this session - the chat falls back to the
 * implicit `default` launch config on next activation. Doesn't tear down
 * the current panes; just removes the explicit binding so a relaunch
 * picks `default` instead of the previously-pinned name.
 */
export function clearLaunchConfigPin(sessionId: string): void {
  useTerminalStore.getState().setSessionLaunchConfigName(sessionId, null)
  void window.api.app.saveSessionLayout(sessionId, snapshotLayoutJson(sessionId), null).catch(() => {})
}

/**
 * Snapshot the session's current layout into a `LaunchConfig`
 * suitable for serializing into launch-config.yaml. CWDs are stored as
 * project-relative paths when possible (so the launch config is portable
 * across machines that have the project at different absolute paths).
 *
 * Caveat: `on_start` is NOT captured - there's no sane way to read
 * back what command(s) the user typed into a live shell. Launch configs
 * created via this snapshot start panes in a plain shell at the
 * recorded cwd; any startup commands need to be added by hand.
 */
function snapshotCurrentAsLaunchConfig(sessionId: string, projectPath: string): LaunchConfig {
  const layout = useTerminalStore.getState().getLayout(sessionId)
  const projectPrefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`

  const toRelativeCwd = (cwd: string | undefined): string | undefined => {
    if (!cwd) return undefined
    if (cwd === projectPath) return '.'
    if (cwd.startsWith(projectPrefix)) return cwd.slice(projectPrefix.length)
    return cwd  // outside the project - keep absolute
  }

  // Each row in YAML corresponds to a row in the live layout. Tabs
  // (multiple panes inside a single window) get flattened into siblings
  // in the same row - we don't have a YAML representation for tabs
  // today, and surfacing them as side-by-side panes loses the least.
  const rows = layout.rows.map((row) => ({
    panes: row.windowIds.flatMap((wid) => {
      const win = layout.windows[wid]
      return win.paneIds.map((pid) => {
        const pane = layout.panes[pid]
        const cwd = toRelativeCwd(pane?.cwd)
        return {
          label: pane?.label ?? 'Terminal',
          ...(cwd ? { cwd } : {}),
        }
      })
    }),
  })).filter((r) => r.panes.length > 0)

  // Flatten to terminals[] when the layout is exactly one row - keeps
  // the YAML shape simpler (legacy `terminals:` flat list) for the
  // common single-row case, and round-trips cleanly through the parser.
  if (rows.length === 1) {
    return { terminals: rows[0].panes }
  }
  // Multi-row layouts use the modern `rows:` shape. `terminals` mirrors
  // every pane in order so callers reading the legacy field still see
  // something sensible.
  return { terminals: rows.flatMap((r) => r.panes), rows }
}

/**
 * Save the session's current pane layout as a named launch config in the
 * project's launch-config.yaml. If a launch config with that name already exists,
 * the call is rejected - caller should rename via the Settings list
 * editor first.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error }` on
 * validation / serialization failure. Does NOT swallow disk errors -
 * those propagate to the caller's catch.
 */
export async function saveCurrentLayoutAsLaunchConfig(
  sessionId: string,
  projectPath: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: 'Launch config name is required.' }

  const yamlContent = await window.api.app.getLaunchConfig(projectPath)
  let config: LaunchConfigFile
  try {
    config = yamlContent ? parseLaunchConfigFile(yamlContent) : { terminals: [], configs: { default: { terminals: [] } } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid launch-config.yaml' }
  }
  // Ensure `default` exists so the resulting file has a valid implicit
  // fallback even when this is the first launch config the user creates.
  const configs = config.configs ?? {}
  if (!configs.default) {
    config = {
      ...config,
      configs: { default: { terminals: config.terminals ?? [] }, ...configs },
    }
  } else {
    config = { ...config, configs }
  }
  const currentLaunchConfigs = config.configs as Record<string, LaunchConfig>

  const body = snapshotCurrentAsLaunchConfig(sessionId, projectPath)

  // If the target name already exists, bail - overwrite would silently
  // lose the user's hand-written `on_start` directives.
  if (currentLaunchConfigs[trimmed]) {
    return { ok: false, error: `Launch config "${trimmed}" already exists. Pick a different name.` }
  }

  const added = launchConfigListReducer(config, { type: 'addLaunchConfig', name: trimmed })
  if (!added.ok) return added

  const replaced = launchConfigListReducer(added.config, {
    type: 'replaceLaunchConfigBody',
    name: trimmed,
    body,
  })
  if (!replaced.ok) return replaced

  const text = serializeLaunchConfigFile(replaced.config)
  await window.api.app.saveLaunchConfig(projectPath, text)
  return { ok: true }
}

function snapshotLayoutJson(sessionId: string): string {
  const layout = useTerminalStore.getState().getLayout(sessionId)
  const layoutData = {
    rows: layout.rows.map((row) => ({
      windows: row.windowIds.map((wid) => {
        const win = layout.windows[wid]
        return {
          panes: win.paneIds.map((pid) => {
            const pane = layout.panes[pid]
            return { label: pane?.label ?? 'Terminal', cwd: pane?.cwd, command: pane?.command }
          }),
        }
      }),
    })),
  }
  return JSON.stringify(layoutData)
}
