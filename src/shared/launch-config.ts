import yaml from 'js-yaml'

// ─── Types ─────────────────────────────────────────────────────────

export interface LaunchConfigTerminal {
  label: string
  cwd?: string
  on_start?: string
  wait_for?: string
}

export interface LaunchConfigRow {
  panes: LaunchConfigTerminal[]
}

/**
 * A single named launch config - either a flat list of terminals or a
 * row/column layout. The two are mutually exclusive at the schema
 * level (presence of `rows` overrides `terminals`).
 */
export interface LaunchConfig {
  terminals: LaunchConfigTerminal[]
  rows?: LaunchConfigRow[]
}

/**
 * The full launch-config file. Modern shape: a map of named configs
 * (`default`, `backend`, `monitoring`, …) under `configs:`. New chats
 * hydrate from `configs.default`; users can switch configs per-chat.
 *
 * For backward compatibility, `terminals` and `rows` continue to
 * mirror the contents of `configs.default` so existing callers
 * (and existing user YAML files with top-level `terminals:` / `rows:`,
 * or the pre-rename `templates:` block) keep working untouched.
 */
export interface LaunchConfigFile {
  terminals: LaunchConfigTerminal[]
  rows?: LaunchConfigRow[]
  configs?: Record<string, LaunchConfig>
}

// ─── Parser ────────────────────────────────────────────────────────

function parseTerminalEntry(raw: unknown, index: number): LaunchConfigTerminal | null {
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
 * Parse a single launch-config body - accepts either `terminals: []` or
 * `rows: []` (rows wins when both are present, matching legacy
 * top-level behavior). Returns `null` if the body has neither.
 */
export function parseLaunchConfigBody(raw: unknown): LaunchConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>

  if (Array.isArray(body.rows)) {
    const rows: LaunchConfigRow[] = []
    const allTerminals: LaunchConfigTerminal[] = []
    let globalIndex = 0
    for (const rowRaw of body.rows) {
      if (typeof rowRaw !== 'object' || rowRaw === null || !Array.isArray((rowRaw as { panes?: unknown }).panes)) {
        continue
      }
      const panes: LaunchConfigTerminal[] = []
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
    const terminals: LaunchConfigTerminal[] = []
    for (let i = 0; i < body.terminals.length; i++) {
      const t = parseTerminalEntry(body.terminals[i], i)
      if (t) terminals.push(t)
    }
    return { terminals }
  }

  return null
}

/**
 * Parse a launch-config.yaml string into a LaunchConfigFile.
 * Throws on invalid YAML syntax.
 *
 * Schema priority:
 *  1. Top-level `terminals:` or `rows:` → materialized as `configs.default`
 *     (back-compat - the oldest files have no named map).
 *  2. `configs: { name: { terminals|rows } }` → named configs. The
 *     pre-rename `templates:` key is still accepted as an alias so files
 *     written before the rename keep working. Top-level + configs can
 *     co-exist; the top-level contents become `configs.default` if no
 *     explicit `default` is declared in the map.
 *
 * Returns empty file (`{ terminals: [], configs: {} }`) for valid
 * YAML with no recognized keys.
 */
export function parseLaunchConfigFile(input: string): LaunchConfigFile {
  if (!input.trim()) {
    return { terminals: [], configs: {} }
  }

  const doc = yaml.load(input) as Record<string, unknown> | null
  if (!doc || typeof doc !== 'object') {
    return { terminals: [], configs: {} }
  }

  const configs: Record<string, LaunchConfig> = {}

  // 1. Hoist top-level terminals/rows into configs.default (back-compat).
  const topLevel = parseLaunchConfigBody(doc)
  if (topLevel) {
    configs.default = topLevel
  }

  // 2. Merge in the named map - `configs:` (modern) or `templates:`
  //    (pre-rename alias). `configs:` wins if both are somehow present.
  const namedMap = (doc.configs ?? doc.templates)
  if (namedMap && typeof namedMap === 'object' && !Array.isArray(namedMap)) {
    for (const [name, body] of Object.entries(namedMap as Record<string, unknown>)) {
      const cfg = parseLaunchConfigBody(body)
      if (cfg) configs[name] = cfg
    }
  }

  // Top-level mirror - existing callers still read `.terminals` and
  // `.rows` directly. We surface the `default` config's contents there.
  const def = configs.default
  return {
    terminals: def?.terminals ?? [],
    rows: def?.rows,
    configs,
  }
}

// ─── Serializer ────────────────────────────────────────────────────

/**
 * Serialize a LaunchConfigFile back to YAML. When `configs` has entries
 * beyond `default`, we emit the modern `configs:` block. When only
 * `default` (or no configs at all) is present, we emit the legacy
 * top-level `terminals:`/`rows:` shape so files a user hand-wrote in
 * v0.1.x continue to look the same after a save round-trip.
 */
export function serializeLaunchConfigFile(config: LaunchConfigFile): string {
  const obj: Record<string, unknown> = {}

  const configs = config.configs ?? {}
  const names = Object.keys(configs)
  const hasNamedExtras = names.some((n) => n !== 'default')

  if (hasNamedExtras) {
    // Modern shape: emit a configs: block. Sort `default` first for
    // readability, then alphabetical.
    const sorted = names.sort((a, b) => {
      if (a === 'default') return -1
      if (b === 'default') return 1
      return a.localeCompare(b)
    })
    obj.configs = Object.fromEntries(
      sorted.map((name) => [name, serializeConfigBody(configs[name])]),
    )
  } else {
    // Legacy shape - preserve the original top-level layout.
    const cfg = configs.default ?? { terminals: config.terminals, rows: config.rows }
    Object.assign(obj, serializeConfigBody(cfg))
  }

  return yaml.dump(obj, { indent: 2, lineWidth: 120, noRefs: true })
}

/**
 * YAML-stringify a single launch-config body (just `terminals:` or
 * `rows:`, no surrounding `configs:` wrapper). Used by the Settings
 * editor where each config's body is edited independently.
 */
export function serializeLaunchConfigBody(cfg: LaunchConfig): string {
  return yaml.dump(serializeConfigBody(cfg), { indent: 2, lineWidth: 120, noRefs: true })
}

/**
 * Parse a YAML string representing a single launch-config body and
 * return the resulting `LaunchConfig`. Returns `null` for empty/invalid
 * input. Throws on YAML syntax errors so the caller can surface them.
 */
export function parseLaunchConfigBodyYaml(input: string): LaunchConfig | null {
  if (!input.trim()) return { terminals: [] }
  const doc = yaml.load(input)
  return parseLaunchConfigBody(doc)
}

function serializeConfigBody(cfg: LaunchConfig): Record<string, unknown> {
  if (cfg.rows && cfg.rows.length > 0) {
    return {
      rows: cfg.rows.map((row) => ({ panes: row.panes.map(serializeTerminal) })),
    }
  }
  return { terminals: cfg.terminals.map(serializeTerminal) }
}

function serializeTerminal(t: LaunchConfigTerminal): Record<string, string> {
  const obj: Record<string, string> = { label: t.label }
  if (t.cwd) obj.cwd = t.cwd
  if (t.on_start) obj.on_start = t.on_start
  if (t.wait_for) obj.wait_for = t.wait_for
  return obj
}
