/**
 * `git grep` definition fallback. When LSP can't resolve a symbol (cold
 * server, or a non-LSP language), grep the repo for its declaration so
 * ⌘-click still lands somewhere useful. Returns repo-relative paths — the
 * same shape openInViewer expects.
 */
import { useAgentStore } from '../stores/agent-store'
import type { DefinitionSources, ResolvedDefinition } from './definitionProvider'

function activeWorkspace(): string | null {
  const s = useAgentStore.getState()
  const sess = s.sessions.find((x) => x.id === s.activeSessionId)
  return sess?.worktreePath ?? sess?.projectPath ?? null
}

export const grepDefinitionSource: NonNullable<DefinitionSources['grep']> = async ({ symbol }) => {
  const root = activeWorkspace()
  if (!root) return []
  const res = await window.api.files.grepSymbol(root, symbol)
  if (!res.ok) return []
  return res.hits.map((h): ResolvedDefinition => ({ path: h.relPath, line: h.line, ch: h.ch }))
}
