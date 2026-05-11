/**
 * Renderer-side façade for the LSP IPC. Owns:
 *   - per-(workspace, path) didOpen / didClose lifecycle
 *   - debounced didChange for the active buffer
 *   - a monotonic version counter per (workspace, path)
 *
 * The actual server boot, framing, and per-language routing live in
 * `src/main/lsp/manager.ts` (main process).
 */
import { createRendererLogger } from '../logger'

const log = createRendererLogger('lsp-client')
const versionByDoc = new Map<string, number>()
const openDocs = new Set<string>()

function key(workspaceRoot: string, absPath: string): string {
  return `${workspaceRoot}::${absPath}`
}

function languageIdForPath(path: string): string | null {
  if (/\.ts$/i.test(path)) return 'typescript'
  if (/\.tsx$/i.test(path)) return 'typescriptreact'
  if (/\.(js|mjs|cjs)$/i.test(path)) return 'javascript'
  if (/\.jsx$/i.test(path)) return 'javascriptreact'
  if (/\.py$/i.test(path)) return 'python'
  return null
}

export async function lspOpenDoc(workspaceRoot: string, absPath: string, text: string): Promise<void> {
  const langId = languageIdForPath(absPath)
  if (!langId) return
  const k = key(workspaceRoot, absPath)
  if (openDocs.has(k)) return
  versionByDoc.set(k, 1)
  openDocs.add(k)
  try {
    await window.api.lsp.open({ workspaceRoot, absPath, text, version: 1, languageId: langId })
    log.debug('didOpen', absPath)
  } catch (err) {
    log.warn('didOpen failed', absPath, err)
    openDocs.delete(k)
    versionByDoc.delete(k)
  }
}

export async function lspChangeDoc(workspaceRoot: string, absPath: string, text: string): Promise<void> {
  const k = key(workspaceRoot, absPath)
  if (!openDocs.has(k)) return
  const next = (versionByDoc.get(k) ?? 0) + 1
  versionByDoc.set(k, next)
  try {
    await window.api.lsp.change({ workspaceRoot, absPath, text, version: next })
  } catch (err) {
    log.warn('didChange failed', absPath, err)
  }
}

export async function lspCloseDoc(workspaceRoot: string, absPath: string): Promise<void> {
  const k = key(workspaceRoot, absPath)
  if (!openDocs.has(k)) return
  openDocs.delete(k)
  versionByDoc.delete(k)
  try {
    await window.api.lsp.close({ workspaceRoot, absPath })
    log.debug('didClose', absPath)
  } catch (err) {
    log.warn('didClose failed', absPath, err)
  }
}

/** Test-only — clear in-memory open-doc tracking between tests. */
export function __resetLspClientForTests(): void {
  openDocs.clear()
  versionByDoc.clear()
}
