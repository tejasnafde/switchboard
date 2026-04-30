import { useEffect, useRef } from 'react'
import { useAgentStore } from '../stores/agent-store'
import { useTerminalStore } from '../stores/terminal-store'
import { parseWorkspaceConfig, serializeWorkspaceConfig, type WorkspaceTemplate, type WorkspaceConfig } from '@shared/workspace-config'
import { planTemplateSpawn, resolveTemplateFallback, resolveCwd, type SpawnOp } from '../services/templatePlanner'
import { recordTemplateUsage } from '../services/templateUsage'
import { getRecentOutputPaneLabels } from '../services/terminal-registry'
import { templateListReducer } from '../services/templateListReducer'

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
  options: { skipDirtyCheck?: boolean } = {},
): Promise<void> {
  const yamlContent = await window.api.app.getWorkspaceConfig(projectPath)
  if (!yamlContent) return
  const config = parseWorkspaceConfig(yamlContent)
  const resolved = resolveTemplateFallback(config, templateName)
  if (!resolved) return

  // Dirty-pane check: warn if any pane in this session has produced output
  // recently. Switching templates tears down all panes, so the user is
  // about to kill anything running (dev server, REPL, ssh session).
  if (!options.skipDirtyCheck) {
    const layout = useTerminalStore.getState().getLayout(sessionId)
    const paneIds = Object.keys(layout.panes)
    const hot = getRecentOutputPaneLabels(paneIds, layout.panes)
    if (hot.length > 0) {
      const list = hot.map((l) => `  • ${l}`).join('\n')
      const ok = window.confirm(
        `Switch to template "${resolved.templateName}"?\n\n` +
        `These panes have produced output in the last 30s and will be killed:\n${list}\n\n` +
        `Press OK to switch anyway.`,
      )
      if (!ok) return
    }
  }

  const store = useTerminalStore.getState()
  store.clearSessionLayout(sessionId)
  spawnFromTemplate(sessionId, resolved.template, projectPath)
  useTerminalStore.getState().setSessionTemplateName(sessionId, resolved.templateName)
  recordTemplateUsage(projectPath, resolved.templateName)

  if (resolved.fellBack && resolved.removedName) {
    window.dispatchEvent(new CustomEvent('sb-template-fallback', {
      detail: { sessionId, removedName: resolved.removedName, fallbackName: resolved.templateName },
    }))
  }

  // Persist immediately so a relaunch picks up the new selection.
  void window.api.app.saveSessionLayout(sessionId, snapshotLayoutJson(sessionId), resolved.templateName).catch(() => {})
}

/**
 * Clear the template pin on this session — the chat falls back to the
 * implicit `default` template on next activation. Doesn't tear down
 * the current panes; just removes the explicit binding so a relaunch
 * picks `default` instead of the previously-pinned name.
 */
export function clearTemplatePin(sessionId: string): void {
  useTerminalStore.getState().setSessionTemplateName(sessionId, null)
  void window.api.app.saveSessionLayout(sessionId, snapshotLayoutJson(sessionId), null).catch(() => {})
}

/**
 * Snapshot the session's current layout into a `WorkspaceTemplate`
 * suitable for serializing into workspace.yaml. CWDs are stored as
 * project-relative paths when possible (so the template is portable
 * across machines that have the project at different absolute paths).
 *
 * Caveat: `on_start` is NOT captured — there's no sane way to read
 * back what command(s) the user typed into a live shell. Templates
 * created via this snapshot start panes in a plain shell at the
 * recorded cwd; any startup commands need to be added by hand.
 */
export function snapshotCurrentAsTemplate(sessionId: string, projectPath: string): WorkspaceTemplate {
  const layout = useTerminalStore.getState().getLayout(sessionId)
  const projectPrefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`

  const toRelativeCwd = (cwd: string | undefined): string | undefined => {
    if (!cwd) return undefined
    if (cwd === projectPath) return '.'
    if (cwd.startsWith(projectPrefix)) return cwd.slice(projectPrefix.length)
    return cwd  // outside the project — keep absolute
  }

  // Each row in YAML corresponds to a row in the live layout. Tabs
  // (multiple panes inside a single window) get flattened into siblings
  // in the same row — we don't have a YAML representation for tabs
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

  // Flatten to terminals[] when the layout is exactly one row — keeps
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
 * Save the session's current pane layout as a named template in the
 * project's workspace.yaml. If a template with that name already exists,
 * the call is rejected — caller should rename via the Settings list
 * editor first.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error }` on
 * validation / serialization failure. Does NOT swallow disk errors —
 * those propagate to the caller's catch.
 */
export async function saveCurrentLayoutAsTemplate(
  sessionId: string,
  projectPath: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: 'Template name is required.' }

  const yamlContent = await window.api.app.getWorkspaceConfig(projectPath)
  let config: WorkspaceConfig
  try {
    config = yamlContent ? parseWorkspaceConfig(yamlContent) : { terminals: [], templates: { default: { terminals: [] } } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid workspace.yaml' }
  }
  // Ensure `default` exists so the resulting file has a valid implicit
  // fallback even when this is the first template the user creates.
  const templates = config.templates ?? {}
  if (!templates.default) {
    config = {
      ...config,
      templates: { default: { terminals: config.terminals ?? [] }, ...templates },
    }
  } else {
    config = { ...config, templates }
  }
  const currentTemplates = config.templates as Record<string, WorkspaceTemplate>

  const body = snapshotCurrentAsTemplate(sessionId, projectPath)

  // If the target name already exists, bail — overwrite would silently
  // lose the user's hand-written `on_start` directives.
  if (currentTemplates[trimmed]) {
    return { ok: false, error: `Template "${trimmed}" already exists. Pick a different name.` }
  }

  const added = templateListReducer(config, { type: 'addTemplate', name: trimmed })
  if (!added.ok) return added

  const replaced = templateListReducer(added.config, {
    type: 'replaceTemplateBody',
    name: trimmed,
    body,
  })
  if (!replaced.ok) return replaced

  const text = serializeWorkspaceConfig(replaced.config)
  await window.api.app.saveWorkspaceConfig(projectPath, text)
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
