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

export interface WorkspaceConfig {
  terminals: WorkspaceTerminal[]
  rows?: WorkspaceRow[]
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
 * Parse a workspace.yaml string into a WorkspaceConfig.
 * Throws on invalid YAML syntax.
 * Returns empty config for valid YAML with no recognized keys.
 */
export function parseWorkspaceConfig(input: string): WorkspaceConfig {
  if (!input.trim()) {
    return { terminals: [] }
  }

  const doc = yaml.load(input) as Record<string, unknown> | null
  if (!doc || typeof doc !== 'object') {
    return { terminals: [] }
  }

  // rows layout takes precedence
  if (Array.isArray(doc.rows)) {
    const rows: WorkspaceRow[] = []
    const allTerminals: WorkspaceTerminal[] = []
    let globalIndex = 0

    for (const rowRaw of doc.rows) {
      if (typeof rowRaw !== 'object' || rowRaw === null || !Array.isArray((rowRaw as any).panes)) {
        continue
      }
      const panes: WorkspaceTerminal[] = []
      for (const paneRaw of (rowRaw as any).panes) {
        const t = parseTerminalEntry(paneRaw, globalIndex++)
        if (t) {
          panes.push(t)
          allTerminals.push(t)
        }
      }
      if (panes.length > 0) {
        rows.push({ panes })
      }
    }

    return { terminals: allTerminals, rows }
  }

  // flat terminals array
  if (Array.isArray(doc.terminals)) {
    const terminals: WorkspaceTerminal[] = []
    for (let i = 0; i < doc.terminals.length; i++) {
      const t = parseTerminalEntry(doc.terminals[i], i)
      if (t) terminals.push(t)
    }
    return { terminals }
  }

  return { terminals: [] }
}

// ─── Serializer ────────────────────────────────────────────────────

export function serializeWorkspaceConfig(config: WorkspaceConfig): string {
  const obj: Record<string, unknown> = {}

  if (config.rows && config.rows.length > 0) {
    obj.rows = config.rows.map((row) => ({
      panes: row.panes.map(serializeTerminal),
    }))
  } else {
    obj.terminals = config.terminals.map(serializeTerminal)
  }

  return yaml.dump(obj, { indent: 2, lineWidth: 120, noRefs: true })
}

function serializeTerminal(t: WorkspaceTerminal): Record<string, string> {
  const obj: Record<string, string> = { label: t.label }
  if (t.cwd) obj.cwd = t.cwd
  if (t.on_start) obj.on_start = t.on_start
  if (t.wait_for) obj.wait_for = t.wait_for
  return obj
}
