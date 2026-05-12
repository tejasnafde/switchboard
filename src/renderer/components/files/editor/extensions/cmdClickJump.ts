/**
 * ⌘-click (macOS) / Ctrl-click (other) → "go to definition". The
 * extension installs a single mousedown DOM event listener on the
 * EditorView. When the modifier is held it:
 *
 *   1. Resolves the click position to a doc offset (CM6's
 *      `view.posAtCoords`).
 *   2. Looks up the word at that offset.
 *   3. Calls `resolveDefinition` (LSP first for ts/py, tree-sitter
 *      else) and navigates to the first hit via `navigateTo`.
 *
 * The plugin needs to know the buffer's path to call the right LSP
 * server; we pass it as a closure when constructing the extension.
 */
import { EditorView, ViewPlugin } from '@codemirror/view'
import { resolveDefinition, defaultTreeSitterSource } from '../../../../services/definitionProvider'
import { lspDefinitionSource } from '../../../../services/lspSource'
import { useAgentStore } from '../../../../stores/agent-store'
import { navigateTo } from '../navigation/navigate'

const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/

function wordAt(view: EditorView, pos: number): { word: string; start: number; end: number } | null {
  const line = view.state.doc.lineAt(pos)
  const text = line.text
  const offset = pos - line.from
  // Walk left + right from `offset` while the char is a word char.
  let start = offset
  let end = offset
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) start--
  while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end++
  if (start === end) return null
  const word = text.slice(start, end)
  if (!WORD_RE.test(word)) return null
  return { word, start: line.from + start, end: line.from + end }
}

export function cmdClickJump(
  getPath: () => string | null,
  getRepoRoot: () => string | null,
) {
  return ViewPlugin.define((view) => {
    const onMouseDown = (e: MouseEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod || e.button !== 0) return
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (pos == null) return
      const w = wordAt(view, pos)
      if (!w) return
      const relPath = getPath()
      if (!relPath) return
      e.preventDefault()
      const repoRoot = getRepoRoot()
      // Build the absolute path the same way EditorHost does for lspOpenDoc.
      const absPath =
        repoRoot && !relPath.startsWith('/')
          ? `${repoRoot}/${relPath}`.replace(/\/+/g, '/')
          : relPath
      const line0 = view.state.doc.lineAt(pos).number - 1
      const ch = pos - view.state.doc.line(line0 + 1).from
      void resolveDefinition({
        path: absPath,
        symbol: w.word,
        position: { line: line0, character: ch },
        sources: { lsp: lspDefinitionSource, treeSitter: defaultTreeSitterSource },
      }).then((defs) => {
        if (defs.length === 0) return
        const target = defs[0]
        // LSP results are absolute; relativize so openInViewer gets a repo-relative path.
        let navPath = target.path
        if (repoRoot && navPath.startsWith(repoRoot + '/')) {
          navPath = navPath.slice(repoRoot.length + 1)
        }
        const sessionId = useAgentStore.getState().activeSessionId
        navigateTo(sessionId, { path: navPath, line: target.line, ch: target.ch })
      })
    }
    view.dom.addEventListener('mousedown', onMouseDown, true)
    return {
      destroy() {
        view.dom.removeEventListener('mousedown', onMouseDown, true)
      },
    }
  })
}
