import yaml from 'js-yaml'

// ─── Types ─────────────────────────────────────────────────────────

export interface WorkspaceTerminal {
  label: string
  cwd?: string
  on_start?: string
  wait_for?: string
}

export interface WorkspaceRow {
  panes: WorkspaceTerminal[]
}

/**
 * Single named template — either a flat list of terminals or a
 * row/column layout. The two are mutually exclusive at the schema
 * level (presence of `rows` overrides `terminals`).
 */
export interface WorkspaceTemplate {
  terminals: WorkspaceTerminal[]
  rows?: WorkspaceRow[]
}

/**
 * The full workspace config. Modern shape: a map of named templates
 * (`default`, `backend`, `monitoring`, …). New chats hydrate from
 * `templates.default`; users can switch templates per-chat.
 *
 * For backward compatibility, `terminals` and `rows` continue to
 * mirror the contents of `templates.default` so existing callers
 * (and existing user YAML files with top-level `terminals:` / `rows:`)
 * keep working untouched.
 */
export interface WorkspaceConfig {
  terminals: WorkspaceTerminal[]
  rows?: WorkspaceRow[]
  templates?: Record<string, WorkspaceTemplate>
}

// ─── Parser ────────────────────────────────────────────────────────

function parseTerminalEntry(raw: unknown, index: number): WorkspaceTerminal | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  return {
    label: typeof entry.label === 'string' ? entry.label : `Terminal ${index + 1}`,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    on_start: typeof entry.on_start === 'string' ? entry.on_start : undefined,
    wait_for: typeof entry.wait_for === 'string' ? entry.wait_for : undefined,
  }
}

/**
 * Parse a single template body — accepts either `terminals: []` or
 * `rows: []` (rows wins when both are present, matching legacy
 * top-level behavior). Returns `null` if the body has neither.
 */
export function parseTemplateBody(raw: unknown): WorkspaceTemplate | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>

  if (Array.isArray(body.rows)) {
    const rows: WorkspaceRow[] = []
    const allTerminals: WorkspaceTerminal[] = []
    let globalIndex = 0
    for (const rowRaw of body.rows) {
      if (typeof rowRaw !== 'object' || rowRaw === null || !Array.isArray((rowRaw as { panes?: unknown }).panes)) {
        continue
      }
      const panes: WorkspaceTerminal[] = []
      for (const paneRaw of (rowRaw as { panes: unknown[] }).panes) {
        const t = parseTerminalEntry(paneRaw, globalIndex++)
        if (t) {
          panes.push(t)
          allTerminals.push(t)
        }
      }
      if (panes.length > 0) rows.push({ panes })
    }
    return { terminals: allTerminals, rows }
  }

  if (Array.isArray(body.terminals)) {
    const terminals: WorkspaceTerminal[] = []
    for (let i = 0; i < body.terminals.length; i++) {
      const t = parseTerminalEntry(body.terminals[i], i)
      if (t) terminals.push(t)
    }
    return { terminals }
  }

  return null
}

/**
 * Parse a workspace.yaml string into a WorkspaceConfig.
 * Throws on invalid YAML syntax.
 *
 * Schema priority:
 *  1. Top-level `terminals:` or `rows:` → materialized as `templates.default`
 *     (back-compat — existing files have no `templates:` block).
 *  2. `templates: { name: { terminals|rows } }` → named templates, merged
 *     into the result. Top-level + templates can co-exist; the top-level
 *     contents become `templates.default` if no explicit `default` is
 *     declared in the templates block.
 *
 * Returns empty config (`{ terminals: [], templates: {} }`) for valid
 * YAML with no recognized keys.
 */
export function parseWorkspaceConfig(input: string): WorkspaceConfig {
  if (!input.trim()) {
    return { terminals: [], templates: {} }
  }

  const doc = yaml.load(input) as Record<string, unknown> | null
  if (!doc || typeof doc !== 'object') {
    return { terminals: [], templates: {} }
  }

  const templates: Record<string, WorkspaceTemplate> = {}

  // 1. Hoist top-level terminals/rows into templates.default (back-compat).
  const topLevel = parseTemplateBody(doc)
  if (topLevel) {
    templates.default = topLevel
  }

  // 2. Merge in explicit templates: { name: { ... } }.
  if (doc.templates && typeof doc.templates === 'object' && !Array.isArray(doc.templates)) {
    for (const [name, body] of Object.entries(doc.templates as Record<string, unknown>)) {
      const tpl = parseTemplateBody(body)
      if (tpl) templates[name] = tpl
    }
  }

  // Top-level mirror — existing callers still read `config.terminals`
  // and `config.rows` directly. We surface the `default` template's
  // contents there.
  const def = templates.default
  return {
    terminals: def?.terminals ?? [],
    rows: def?.rows,
    templates,
  }
}

// ─── Serializer ────────────────────────────────────────────────────

/**
 * Serialize a WorkspaceConfig back to YAML. When `templates` has
 * entries beyond `default`, we emit the modern `templates:` block.
 * When only `default` (or no templates at all) is present, we emit
 * the legacy top-level `terminals:`/`rows:` shape so files a user
 * hand-wrote in v0.1.x continue to look the same after a save round-trip.
 */
export function serializeWorkspaceConfig(config: WorkspaceConfig): string {
  const obj: Record<string, unknown> = {}

  const templates = config.templates ?? {}
  const templateNames = Object.keys(templates)
  const hasNamedExtras = templateNames.some((n) => n !== 'default')

  if (hasNamedExtras) {
    // Modern shape: emit a templates: block. Sort `default` first for
    // readability, then alphabetical.
    const sorted = templateNames.sort((a, b) => {
      if (a === 'default') return -1
      if (b === 'default') return 1
      return a.localeCompare(b)
    })
    obj.templates = Object.fromEntries(
      sorted.map((name) => [name, serializeTemplate(templates[name])]),
    )
  } else {
    // Legacy shape — preserve the original top-level layout.
    const tpl = templates.default ?? { terminals: config.terminals, rows: config.rows }
    Object.assign(obj, serializeTemplate(tpl))
  }

  return yaml.dump(obj, { indent: 2, lineWidth: 120, noRefs: true })
}

/**
 * YAML-stringify a single template body (just `terminals:` or `rows:`,
 * no surrounding `templates:` wrapper). Used by the Settings template
 * editor where each template's body is edited independently.
 */
export function serializeTemplateBody(tpl: WorkspaceTemplate): string {
  return yaml.dump(serializeTemplate(tpl), { indent: 2, lineWidth: 120, noRefs: true })
}

/**
 * Parse a YAML string representing a single template body and return
 * the resulting `WorkspaceTemplate`. Returns `null` for empty/invalid
 * input. Throws on YAML syntax errors so the caller can surface them.
 */
export function parseTemplateBodyYaml(input: string): WorkspaceTemplate | null {
  if (!input.trim()) return { terminals: [] }
  const doc = yaml.load(input)
  return parseTemplateBody(doc)
}

function serializeTemplate(tpl: WorkspaceTemplate): Record<string, unknown> {
  if (tpl.rows && tpl.rows.length > 0) {
    return {
      rows: tpl.rows.map((row) => ({ panes: row.panes.map(serializeTerminal) })),
    }
  }
  return { terminals: tpl.terminals.map(serializeTerminal) }
}

function serializeTerminal(t: WorkspaceTerminal): Record<string, string> {
  const obj: Record<string, string> = { label: t.label }
  if (t.cwd) obj.cwd = t.cwd
  if (t.on_start) obj.on_start = t.on_start
  if (t.wait_for) obj.wait_for = t.wait_for
  return obj
}
