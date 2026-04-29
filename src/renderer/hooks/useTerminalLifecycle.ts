import { useEffect, useRef } from 'react'
import { useAgentStore } from '../stores/agent-store'
import { useTerminalStore } from '../stores/terminal-store'
import { parseWorkspaceConfig, type WorkspaceTemplate } from '@shared/workspace-config'
import { planTemplateSpawn, resolveTemplateFallback, resolveCwd, type SpawnOp } from '../services/templatePlanner'

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
 * workspace.yaml mapping (v0.1.20+):
 *   - Templates live under `templates: { default: { ... }, backend: { ... } }`
 *     in workspace.yaml. The legacy top-level `terminals:` / `rows:` keys
 *     materialize as `templates.default` for back-compat.
 *   - Each session records which template name it hydrated from in
 *     `session_layouts.template_name` so the picker chip + hot-reload
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
        // Capture the session's current template name BEFORE clearing
        // so the respawn can ask for the same one — the resolver will
        // fall back to default if the user just deleted it from YAML.
        const currentTemplate = useTerminalStore.getState().getSessionTemplateName(activeId)
        useTerminalStore.getState().clearSessionLayout(activeId)
        spawnTerminalsForSession(activeId, projectPath, true, currentTemplate)
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
        const templateName = useTerminalStore.getState().getSessionTemplateName?.(sessionId) ?? null
        window.api.app.saveSessionLayout(sessionId, JSON.stringify(layoutData), templateName).catch(() => {})
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
  forceWorkspaceConfig = false,
  requestedTemplate: string | null = null,
) {
  const store = useTerminalStore.getState()

  // 1. Try SQLite — restore the prior live layout exactly. Picker
  //    badge gets the saved template_name back so the user sees the
  //    name they chose last session.
  if (!forceWorkspaceConfig) {
    try {
      const saved = await window.api.app.getSessionLayout(sessionId)
      if (saved && saved.layoutJson) {
        const parsed = JSON.parse(saved.layoutJson) as { rows?: SavedRow[] }
        if (parsed.rows && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
          restoreFromSaved(sessionId, parsed.rows, projectPath)
          if (saved.templateName) useTerminalStore.getState().setSessionTemplateName(sessionId, saved.templateName)
          return
        }
      }
    } catch { /* fall through */ }
  }

  // 2. Try workspace.yaml — hydrate from named template (or default).
  if (projectPath) {
    try {
      const yamlContent = await window.api.app.getWorkspaceConfig(projectPath)
      if (yamlContent) {
        const config = parseWorkspaceConfig(yamlContent)
        const resolved = resolveTemplateFallback(config, requestedTemplate)
        if (resolved) {
          if (resolved.fellBack && resolved.removedName) {
            window.dispatchEvent(new CustomEvent('sb-template-fallback', {
              detail: { sessionId, removedName: resolved.removedName, fallbackName: resolved.templateName },
            }))
          }
          spawnFromTemplate(sessionId, resolved.template, projectPath)
          useTerminalStore.getState().setSessionTemplateName(sessionId, resolved.templateName)
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

/**
 * Walk a planner op list and dispatch each op to the terminal store.
 * Pure top-of-store — no PTY work happens here, just layout shape.
 */
function spawnFromTemplate(sessionId: string, template: WorkspaceTemplate, projectPath: string) {
  const store = useTerminalStore.getState()
  const ops: SpawnOp[] = planTemplateSpawn(template, projectPath)
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

// ─── Public: switch the active template for a session ──────────────

/**
 * Tear down the session's current panes and re-hydrate from a named
 * template. Called by the per-chat picker chip in the terminal strip
 * header. If the requested template doesn't exist (race with a save
 * that just deleted it), falls back to `default` and dispatches the
 * `sb-template-fallback` event so the UI can toast.
 */
export async function applyTemplate(
  sessionId: string,
  templateName: string,
  projectPath: string,
): Promise<void> {
  const yamlContent = await window.api.app.getWorkspaceConfig(projectPath)
  if (!yamlContent) return
  const config = parseWorkspaceConfig(yamlContent)
  const resolved = resolveTemplateFallback(config, templateName)
  if (!resolved) return

  const store = useTerminalStore.getState()
  store.clearSessionLayout(sessionId)
  spawnFromTemplate(sessionId, resolved.template, projectPath)
  useTerminalStore.getState().setSessionTemplateName(sessionId, resolved.templateName)

  if (resolved.fellBack && resolved.removedName) {
    window.dispatchEvent(new CustomEvent('sb-template-fallback', {
      detail: { sessionId, removedName: resolved.removedName, fallbackName: resolved.templateName },
    }))
  }

  // Persist immediately so a relaunch picks up the new selection.
  void window.api.app.saveSessionLayout(sessionId, snapshotLayoutJson(sessionId), resolved.templateName).catch(() => {})
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
