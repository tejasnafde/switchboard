/**
 * Resolve "find all references" for the symbol at a position, with a one-line
 * code preview per hit (for the inline peek panel). LSP-only - returns [] for
 * unsupported languages or a cold server. Paths come back repo-relative.
 */
import { useAgentStore } from '../stores/agent-store'

export interface ResolvedReference {
  /** Repo-relative path. */
  path: string
  /** 1-based line. */
  line: number
  ch: number
  /** Trimmed text of the referenced line (empty if unreadable). */
  preview: string
}

interface LspLocation {
  uri: string
  range: { start: { line: number; character: number } }
}

function activeWorkspace(): string | null {
  const s = useAgentStore.getState()
  const sess = s.sessions.find((x) => x.id === s.activeSessionId)
  return sess?.worktreePath ?? sess?.projectPath ?? null
}

function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  const stripped = uri.slice('file://'.length)
  if (/^\/[A-Za-z]:/.test(stripped)) return decodeURIComponent(stripped.slice(1)) // Windows
  return decodeURIComponent(stripped)
}

export async function resolveReferences(
  absPath: string,
  position: { line: number; character: number },
): Promise<ResolvedReference[]> {
  const root = activeWorkspace()
  if (!root) return []
  const res = await window.api.lsp.references({ workspaceRoot: root, absPath, position })
  if (!res.ok || !res.supported) return []

  const refs = (res.locations as LspLocation[]).map((loc) => {
    let p = uriToPath(loc.uri)
    if (p.startsWith(root + '/')) p = p.slice(root.length + 1)
    return { path: p, line: loc.range.start.line + 1, ch: loc.range.start.character }
  })

  // Fetch each referenced file once, slice the line for a preview.
  const paths = [...new Set(refs.map((r) => r.path))]
  const linesByPath = new Map<string, string[]>()
  try {
    const batch = await window.api.files.readBatch(root, paths)
    if (batch.ok) for (const f of batch.files) linesByPath.set(f.path, f.content.split(/\r?\n/))
  } catch {
    /* previews are best-effort */
  }

  return refs.map((r) => ({ ...r, preview: (linesByPath.get(r.path)?.[r.line - 1] ?? '').trim() }))
}
