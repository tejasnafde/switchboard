/**
 * ⌘-click (macOS) / Ctrl-click (other) → "go to definition", plus a
 * VS Code-style underline on the hovered word while the modifier is held
 * so there's a visible affordance that the symbol is clickable.
 *
 * Resolution order (definitionProvider): LSP for ts/py → repo-wide
 * `git grep` fallback → tree-sitter index. The first hit is opened via
 * `navigateTo`. The buffer's path is supplied as a closure so we can call
 * the right LSP server.
 */
import { EditorView, ViewPlugin, Decoration, type DecorationSet } from '@codemirror/view'
import { StateField, StateEffect, type Extension } from '@codemirror/state'
import { resolveDefinition, defaultTreeSitterSource } from '../../../../services/definitionProvider'
import { lspDefinitionSource } from '../../../../services/lspSource'
import { grepDefinitionSource } from '../../../../services/grepSource'
import { useAgentStore } from '../../../../stores/agent-store'
import { navigateTo } from '../navigation/navigate'
import { createRendererLogger } from '../../../../logger'

const log = createRendererLogger('editor:cmd-click-jump')
const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/

export function wordAt(view: EditorView, pos: number): { word: string; start: number; end: number } | null {
  const line = view.state.doc.lineAt(pos)
  const text = line.text
  const offset = pos - line.from
  let start = offset
  let end = offset
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) start--
  while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end++
  if (start === end) return null
  const word = text.slice(start, end)
  if (!WORD_RE.test(word)) return null
  return { word, start: line.from + start, end: line.from + end }
}

// Underline decoration for the hovered, modifier-held word.
const setHover = StateEffect.define<{ from: number; to: number } | null>()
const clickableMark = Decoration.mark({ class: 'cm-cmd-clickable' })

const hoverField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setHover)) {
        deco = e.value
          ? Decoration.set([clickableMark.range(e.value.from, e.value.to)])
          : Decoration.none
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

const clickableTheme = EditorView.theme({
  '.cm-cmd-clickable': { textDecoration: 'underline', cursor: 'pointer' },
})

/**
 * Resolve + navigate to the definition of the symbol at doc offset `pos`.
 * Shared by ⌘-click (pos = click) and F12 (pos = cursor).
 */
export function runDefinitionJump(
  view: EditorView,
  pos: number,
  getPath: () => string | null,
  getRepoRoot: () => string | null,
): void {
  const w = wordAt(view, pos)
  if (!w) return
  const relPath = getPath()
  if (!relPath) return
  const repoRoot = getRepoRoot()
  const absPath =
    repoRoot && !relPath.startsWith('/')
      ? `${repoRoot}/${relPath}`.replace(/\/+/g, '/')
      : relPath
  const line0 = view.state.doc.lineAt(pos).number - 1
  const ch = pos - view.state.doc.line(line0 + 1).from
  const sessionId = useAgentStore.getState().activeSessionId
  void resolveDefinition({
    path: absPath,
    symbol: w.word,
    position: { line: line0, character: ch },
    sources: { lsp: lspDefinitionSource, treeSitter: defaultTreeSitterSource, grep: grepDefinitionSource },
  })
    .then((defs) => {
      if (defs.length === 0) return
      const target = defs[0]
      let navPath = target.path
      if (repoRoot && navPath.startsWith(repoRoot + '/')) {
        navPath = navPath.slice(repoRoot.length + 1)
      }
      navigateTo(sessionId, { path: navPath, line: target.line, ch: target.ch })
    })
    .catch((err) => log.warn('jump-to-definition failed', { symbol: w.word, err }))
}

/** F12 — jump to definition of the symbol under the cursor. */
export function jumpToDefinitionAtCursor(
  view: EditorView,
  getPath: () => string | null,
  getRepoRoot: () => string | null,
): void {
  runDefinitionJump(view, view.state.selection.main.head, getPath, getRepoRoot)
}

export function cmdClickJump(
  getPath: () => string | null,
  getRepoRoot: () => string | null,
): Extension {
  const plugin = ViewPlugin.define((view) => {
    let lastX = 0
    let lastY = 0
    let cur: { from: number; to: number } | null = null

    const rangeAt = (x: number, y: number): { from: number; to: number } | null => {
      const pos = view.posAtCoords({ x, y })
      if (pos == null) return null
      const w = wordAt(view, pos)
      return w ? { from: w.start, to: w.end } : null
    }
    // Dispatch the underline effect only when the highlighted word changes.
    const apply = (range: { from: number; to: number } | null): void => {
      const same =
        (!range && !cur) ||
        (!!range && !!cur && range.from === cur.from && range.to === cur.to)
      if (same) return
      cur = range
      view.dispatch({ effects: setHover.of(range) })
    }

    const onMove = (e: MouseEvent): void => {
      lastX = e.clientX
      lastY = e.clientY
      apply(e.metaKey || e.ctrlKey ? rangeAt(e.clientX, e.clientY) : null)
    }
    // Pressing/releasing the modifier while the mouse is stationary should
    // show/hide the underline too — recompute at the last known position.
    const onKey = (e: KeyboardEvent): void => {
      apply(e.metaKey || e.ctrlKey ? rangeAt(lastX, lastY) : null)
    }
    const onLeave = (): void => apply(null)

    const onMouseDown = (e: MouseEvent): void => {
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod || e.button !== 0) return
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (pos == null) return
      if (!wordAt(view, pos) || !getPath()) return
      e.preventDefault()
      apply(null)
      runDefinitionJump(view, pos, getPath, getRepoRoot)
    }

    view.dom.addEventListener('mousedown', onMouseDown, true)
    view.dom.addEventListener('mousemove', onMove)
    view.dom.addEventListener('mouseleave', onLeave)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return {
      destroy() {
        view.dom.removeEventListener('mousedown', onMouseDown, true)
        view.dom.removeEventListener('mousemove', onMove)
        view.dom.removeEventListener('mouseleave', onLeave)
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('keyup', onKey)
      },
    }
  })
  return [hoverField, clickableTheme, plugin]
}
