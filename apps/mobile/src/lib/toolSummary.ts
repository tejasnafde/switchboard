/**
 * Pick the one field of a tool call that says what it is doing, instead of
 * dumping JSON. Covers Claude's tool names and the Codex/OpenCode spellings.
 */

export interface ToolSummary {
  /** Human name for the header, e.g. "Bash" -> "Terminal". */
  title: string
  /** The one-line what-it-is-doing. Empty when the tool takes no useful arg. */
  detail: string
  /** Render `detail` in the mono face (commands, paths, patterns). */
  mono: boolean
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

/** First non-empty string among the given keys. */
function pick(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = str(o[k])
    if (v !== null) return v
  }
  return null
}

/** Collapse whitespace and cap length so a row stays one line. */
export function condense(s: string, max = 140): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Last two segments - agent paths are deep and the tail identifies the file. */
export function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= 2) return p
  return `…/${parts.slice(-2).join('/')}`
}

const TITLES: Record<string, string> = {
  bash: 'Terminal',
  shell: 'Terminal',
  read: 'Read',
  read_file: 'Read',
  write: 'Write',
  write_file: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  multiedit: 'Edit',
  grep: 'Search',
  search_files: 'Search',
  glob: 'Find files',
  list_files: 'List files',
  ls: 'List files',
  webfetch: 'Fetch',
  fetch: 'Fetch',
  websearch: 'Web search',
  task: 'Subagent',
  todowrite: 'Plan',
  notebookedit: 'Edit notebook',
}

export function summarizeTool(toolName: string, input: unknown): ToolSummary {
  const key = toolName.toLowerCase()
  const o = asRecord(input)
  const title = TITLES[key] ?? toolName

  switch (key) {
    case 'bash':
    case 'shell': {
      // Codex sends argv as string[]; Claude sends a string.
      const raw = o.command
      const cmd = Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').join(' ') : str(raw)
      return { title, detail: condense(cmd ?? ''), mono: true }
    }

    case 'read':
    case 'read_file':
    case 'write':
    case 'write_file':
    case 'edit':
    case 'multiedit':
    case 'notebookedit': {
      const path = pick(o, 'file_path', 'path', 'filePath', 'notebook_path')
      return { title, detail: path ? shortenPath(path) : '', mono: true }
    }

    case 'apply_patch': {
      // The patch body names its files; show those, not the diff.
      const patch = pick(o, 'patch', 'input', 'diff') ?? ''
      const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1])
      if (files.length === 1) return { title, detail: shortenPath(files[0]), mono: true }
      if (files.length > 1) return { title, detail: `${files.length} files`, mono: false }
      return { title, detail: '', mono: false }
    }

    case 'grep':
    case 'search_files': {
      const pattern = pick(o, 'pattern', 'query', 'regex')
      const where = pick(o, 'path', 'dir', 'directory')
      const scope = where ? ` in ${shortenPath(where)}` : ''
      return { title, detail: pattern ? condense(pattern + scope) : '', mono: true }
    }

    case 'glob':
      return { title, detail: condense(pick(o, 'pattern', 'query') ?? ''), mono: true }

    case 'list_files':
    case 'ls':
      return { title, detail: shortenPath(pick(o, 'path', 'dir', 'directory') ?? ''), mono: true }

    case 'webfetch':
    case 'fetch': {
      const url = pick(o, 'url', 'uri')
      // Host identifies it; a full URL just wraps.
      const host = url?.match(/^https?:\/\/([^/]+)/)?.[1]
      return { title, detail: host ?? condense(url ?? ''), mono: false }
    }

    case 'websearch':
      return { title, detail: condense(pick(o, 'query', 'q') ?? ''), mono: false }

    case 'task': {
      const desc = pick(o, 'description', 'prompt')
      return { title, detail: condense(desc ?? '', 80), mono: false }
    }

    case 'todowrite': {
      const todos = o.todos
      const n = Array.isArray(todos) ? todos.length : 0
      return { title, detail: n > 0 ? `${n} ${n === 1 ? 'item' : 'items'}` : '', mono: false }
    }

    default: {
      // Unknown tool: a plausible field beats raw JSON.
      const guess = pick(o, 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'description')
      if (guess !== null) return { title, detail: condense(guess), mono: true }
      const keys = Object.keys(o)
      if (keys.length === 0) return { title, detail: '', mono: false }
      return { title, detail: condense(keys.join(', '), 60), mono: false }
    }
  }
}
