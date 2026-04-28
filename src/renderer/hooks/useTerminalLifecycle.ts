import { useEffect, useRef } from 'react'
import { useAgentStore } from '../stores/agent-store'
import { useTerminalStore } from '../stores/terminal-store'
import { parseWorkspaceConfig, type WorkspaceConfig } from '@shared/workspace-config'

/**
 * Manages terminal lifecycle tied to agent sessions.
 *
 * Model: Session → Rows → Windows (columns) → Panes (tabs inside a window).
 *
 * - No terminals on cold start (empty state)
 * - When a session is activated the FIRST time: load layout from SQLite →
 *   workspace.yaml → default (single window with one pane)
 * - When switching sessions: PTYs STAY ALIVE — we just show/hide based on active session
 * - PTYs only killed when: user closes a pane or session is deleted
 *
 * workspace.yaml mapping:
 *   - Each `terminals:` entry = one window with one pane
 *   - `rows:[].panes:[]` — each `panes` entry becomes a window in that row
 *     (same horizontal row); use `addPaneToWindow` if you want tabs.
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

    spawnTerminalsForSession(activeSessionId, session.projectPath)
  }, [activeSessionId])

  // Watch for workspace.yaml changes to hot-reload
  useEffect(() => {
    if (!window.api.app.onWorkspaceChanged) return
    const cleanup = window.api.app.onWorkspaceChanged((projectPath) => {
      const activeId = useAgentStore.getState().activeSessionId
      if (!activeId) return
      
      const session = useAgentStore.getState().sessions.find((s) => s.id === activeId)
      if (session && session.projectPath === projectPath) {
        // Clear layout and respawn from new config
        useTerminalStore.getState().clearSessionLayout(activeId)
        spawnTerminalsForSession(activeId, projectPath, true)
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
        window.api.app.saveSessionLayout(sessionId, JSON.stringify(layoutData)).catch(() => {})
      }
    }, 30000)

    return () => clearInterval(interval)
  }, [])
}

// ─── Hydration helpers ──────────────────────────────────────────────

interface SavedPane { label?: string; cwd?: string; command?: string; wait_for?: string }
interface SavedWindow { panes?: SavedPane[] }
interface SavedRow { windows?: SavedWindow[]; panes?: SavedPane[] /* legacy */ }

async function spawnTerminalsForSession(sessionId: string, projectPath?: string, forceWorkspaceConfig = false) {
  const store = useTerminalStore.getState()

  // 1. Try SQLite
  if (!forceWorkspaceConfig) {
    try {
      const layoutJson = await window.api.app.getSessionLayout(sessionId)
      if (layoutJson) {
        const saved = JSON.parse(layoutJson) as { rows?: SavedRow[] }
        if (saved.rows && Array.isArray(saved.rows) && saved.rows.length > 0) {
          restoreFromSaved(sessionId, saved.rows, projectPath)
          return
        }
      }
    } catch { /* fall through */ }
  }

  // 2. Try workspace.yaml
  if (projectPath) {
    try {
      const yamlContent = await window.api.app.getWorkspaceConfig(projectPath)
      if (yamlContent) {
        const config = parseWorkspaceConfig(yamlContent)
        spawnFromConfig(sessionId, config, projectPath)
        return
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
      // `stale: true` — panes restored from the previous session start in
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
        // New row — split down
        windowRef = store.splitActiveWindow(sessionId, 'column', commonOpts(first))
      } else {
        // Same row — split right
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

function spawnFromConfig(sessionId: string, config: WorkspaceConfig, projectPath: string) {
  const store = useTerminalStore.getState()

  if (config.rows && config.rows.length > 0) {
    let firstWindow = true
    for (let ri = 0; ri < config.rows.length; ri++) {
      const row = config.rows[ri]
      if (row.panes.length === 0) continue

      for (let pi = 0; pi < row.panes.length; pi++) {
        const p = row.panes[pi]
        if (firstWindow) {
          store.addWindow(sessionId, {
            label: p.label,
            cwd: resolveCwd(p.cwd, projectPath),
            command: p.on_start,
            wait_for: p.wait_for,
          })
          firstWindow = false
        } else if (pi === 0) {
          store.splitActiveWindow(sessionId, 'column', {
            label: p.label,
            cwd: resolveCwd(p.cwd, projectPath),
            command: p.on_start,
            wait_for: p.wait_for,
          })
        } else {
          store.splitActiveWindow(sessionId, 'row', {
            label: p.label,
            cwd: resolveCwd(p.cwd, projectPath),
            command: p.on_start,
            wait_for: p.wait_for,
          })
        }
      }
    }
  } else if (config.terminals.length > 0) {
    for (let i = 0; i < config.terminals.length; i++) {
      const t = config.terminals[i]
      if (i === 0) {
        store.addWindow(sessionId, {
          label: t.label,
          cwd: resolveCwd(t.cwd, projectPath),
          command: t.on_start,
          wait_for: t.wait_for,
        })
      } else {
        store.splitActiveWindow(sessionId, 'row', {
          label: t.label,
          cwd: resolveCwd(t.cwd, projectPath),
          command: t.on_start,
          wait_for: t.wait_for,
        })
      }
    }
  }
}

function resolveCwd(cwd: string | undefined, projectPath: string | undefined): string | undefined {
  if (!cwd) return projectPath || undefined
  if (cwd.startsWith('/')) return cwd
  if (!projectPath) return cwd
  if (cwd === '.') return projectPath
  return `${projectPath}/${cwd}`
}
