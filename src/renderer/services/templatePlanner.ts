/**
 * Pure planner that turns a parsed `WorkspaceTemplate` into a sequence of
 * terminal-store ops. Exists so the lifecycle hook stays a thin shell over
 * tested logic — see `tests/unit/template-apply.test.ts` for the contract.
 *
 * The op vocabulary mirrors `useTerminalStore`:
 *   - addWindow      → first pane in the layout (anchor)
 *   - splitRow       → next pane in the same row (split right)
 *   - splitColumn    → first pane of a new row (split down)
 *
 * The hook walks the ops in order and dispatches each to the store; this
 * file does no DOM / IPC / Electron work.
 */
import type { WorkspaceConfig, WorkspaceTemplate } from '../../shared/workspace-config'

export interface SpawnOpts {
  label: string
  cwd?: string
  command?: string
  wait_for?: string
}

export type SpawnOpKind = 'addWindow' | 'splitRow' | 'splitColumn'

export interface SpawnOp {
  kind: SpawnOpKind
  opts: SpawnOpts
}

/**
 * Resolve a relative cwd against the project root. Mirrors the inline
 * helper in the original `useTerminalLifecycle.ts`.
 *  - undefined        → projectPath (or undefined if no project)
 *  - absolute (`/x`)  → unchanged
 *  - `.`              → projectPath
 *  - relative         → `<projectPath>/<cwd>`
 */
export function resolveCwd(cwd: string | undefined, projectPath: string | undefined): string | undefined {
  if (!cwd) return projectPath || undefined
  if (cwd.startsWith('/')) return cwd
  if (!projectPath) return cwd
  if (cwd === '.') return projectPath
  return `${projectPath}/${cwd}`
}

function makeOpts(t: { label: string; cwd?: string; on_start?: string; wait_for?: string }, projectPath: string | undefined): SpawnOpts {
  return {
    label: t.label,
    cwd: resolveCwd(t.cwd, projectPath),
    command: t.on_start,
    wait_for: t.wait_for,
  }
}

/**
 * Turn a template into an ordered op list. Empty templates emit a single
 * default `addWindow` so the user always sees at least one pane after a
 * template swap.
 */
export function planTemplateSpawn(template: WorkspaceTemplate, projectPath: string | undefined): SpawnOp[] {
  const ops: SpawnOp[] = []

  if (template.rows && template.rows.length > 0) {
    let firstPlaced = false
    for (const row of template.rows) {
      if (row.panes.length === 0) continue
      let firstInRow = true
      for (const pane of row.panes) {
        const opts = makeOpts(pane, projectPath)
        if (!firstPlaced) {
          ops.push({ kind: 'addWindow', opts })
          firstPlaced = true
          firstInRow = false
        } else if (firstInRow) {
          ops.push({ kind: 'splitColumn', opts })
          firstInRow = false
        } else {
          ops.push({ kind: 'splitRow', opts })
        }
      }
    }
    if (firstPlaced) return ops
  }

  if (template.terminals.length > 0) {
    for (let i = 0; i < template.terminals.length; i++) {
      const t = template.terminals[i]
      const opts = makeOpts(t, projectPath)
      ops.push({ kind: i === 0 ? 'addWindow' : 'splitRow', opts })
    }
    return ops
  }

  // Empty template — emit one default pane so the strip isn't blank.
  return [{
    kind: 'addWindow',
    opts: { label: 'Terminal 1', cwd: projectPath, command: undefined, wait_for: undefined },
  }]
}

// ─── Hot-reload fallback ──────────────────────────────────────────

export interface TemplateResolution {
  template: WorkspaceTemplate
  templateName: string
  /** True when the requested template was missing and we fell back to default. */
  fellBack: boolean
  /** Set when fellBack=true — the name the user originally requested. */
  removedName?: string
}

/**
 * Pick the right template to hydrate from. Used both at first session
 * activation (no requested name → default) and on workspace.yaml hot
 * reload (requested name might no longer exist).
 *
 * Returns `null` only when the config is genuinely empty (no `default`
 * and no requested template). Callers should fall back to the
 * single-pane default in that case.
 */
export function resolveTemplateFallback(
  config: WorkspaceConfig,
  requestedName: string | null,
): TemplateResolution | null {
  const templates = config.templates ?? {}
  if (requestedName && templates[requestedName]) {
    return { template: templates[requestedName], templateName: requestedName, fellBack: false }
  }
  if (templates.default) {
    return {
      template: templates.default,
      templateName: 'default',
      fellBack: requestedName != null && requestedName !== 'default',
      removedName: requestedName != null && requestedName !== 'default' ? requestedName : undefined,
    }
  }
  return null
}
