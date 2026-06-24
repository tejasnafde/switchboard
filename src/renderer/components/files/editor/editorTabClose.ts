/**
 * Close an editor tab: confirm if dirty, drop the buffer, and tell the LSP
 * the document closed. Shared by the tab-strip × button and the ⌘W handler so
 * both paths behave identically.
 */
import { useEditorStore } from '../../../stores/editor-store'
import { useAgentStore } from '../../../stores/agent-store'
import { lspCloseDoc } from '../../../services/lspClient'

function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return sep >= 0 ? path.slice(sep + 1) : path
}

export function closeEditorTab(sessionId: string, bufferId: string): void {
  const store = useEditorStore.getState()
  const buf = store.buffers[bufferId]
  if (!buf) return
  if (buf.dirty && !window.confirm(`Discard unsaved changes to ${basename(buf.path)}?`)) return
  store.closeBuffer(bufferId, { force: true })
  const session = useAgentStore.getState().sessions.find((s) => s.id === sessionId)
  const repoRoot = session?.worktreePath ?? session?.projectPath
  if (repoRoot) void lspCloseDoc(repoRoot, `${repoRoot}/${buf.path}`.replace(/\/+/g, '/'))
}
