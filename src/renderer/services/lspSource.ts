/**
 * Adapter that turns the renderer-side LSP IPC into the
 * `DefinitionSources['lsp']` shape expected by `definitionProvider`.
 *
 *   - calls `window.api.lsp.definition` with workspace + abs path + LSP-position
 *   - converts each LSP `Location` into ResolvedDefinition
 *   - silently returns empty when the language is unsupported
 *
 * Workspace root is resolved via the agent-store's active session (the
 * worktree path if set, else the project path) — same routing as
 * `ChatPanel`'s cwd resolution.
 */
import { useAgentStore } from '../stores/agent-store'
import type { DefinitionSources, ResolvedDefinition } from './definitionProvider'

interface LspLocation {
  uri: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

function uriToPath(uri: string): string {
  // file:///abs/path → /abs/path (POSIX) or C:/foo (Windows).
  if (!uri.startsWith('file://')) return uri
  const stripped = uri.slice('file://'.length)
  // On Windows file:///C:/foo → /C:/foo — drop the leading `/`.
  if (/^\/[A-Za-z]:/.test(stripped)) return decodeURIComponent(stripped.slice(1))
  return decodeURIComponent(stripped)
}

function activeWorkspace(): string | null {
  const session = useAgentStore.getState().sessions.find(
    (s) => s.id === useAgentStore.getState().activeSessionId,
  )
  return session?.worktreePath ?? session?.projectPath ?? null
}

export const lspDefinitionSource: DefinitionSources['lsp'] = async ({ path, position }) => {
  const workspaceRoot = activeWorkspace()
  if (!workspaceRoot) return []
  const res = await window.api.lsp.definition({
    workspaceRoot,
    absPath: path,
    position,
  })
  if (!res.ok || !res.supported) return []
  return res.locations.map((loc: LspLocation): ResolvedDefinition => ({
    path: uriToPath(loc.uri),
    line: loc.range.start.line + 1, // LSP is 0-based; we use 1-based
    ch: loc.range.start.character,
  }))
}
