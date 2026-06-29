/**
 * Inline "Go to References" peek panel (VS Code-style). A block widget docked
 * under the cursor's line lists every call site with a one-line code preview;
 * ↑↓ moves the selection, Enter / click opens it, Esc closes. Single results
 * auto-jump (handled in runReferences); the panel only appears for 2+.
 */
import { EditorView, Decoration, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { StateField, StateEffect, Prec, type Extension } from '@codemirror/state'
import { navigateTo, recordLocation } from '../navigation/navigate'
import { useAgentStore } from '../../../../stores/agent-store'
import { resolveReferences, type ResolvedReference } from '../../../../services/referencesSource'
import { wordAt } from './cmdClickJump'

interface PeekState {
  /** 1-based line the panel docks under. */
  line: number
  refs: ResolvedReference[]
  selected: number
  symbol: string
}

const openPeek = StateEffect.define<{ line: number; refs: ResolvedReference[]; symbol: string }>()
const closePeek = StateEffect.define<null>()
const movePeek = StateEffect.define<number>()

/** Decide what a references result count should do. Pure - unit-tested. */
export function referenceAction(count: number): 'none' | 'jump' | 'peek' {
  if (count <= 0) return 'none'
  if (count === 1) return 'jump'
  return 'peek'
}

const peekField = StateField.define<PeekState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(openPeek)) value = { line: e.value.line, refs: e.value.refs, selected: 0, symbol: e.value.symbol }
      else if (e.is(closePeek)) value = null
      else if (e.is(movePeek) && value) {
        const n = value.refs.length
        value = { ...value, selected: (value.selected + e.value + n) % n }
      }
    }
    // A doc edit invalidates the anchored line - drop the panel.
    if (value && tr.docChanged) value = null
    return value
  },
})

function openRef(view: EditorView, ref: ResolvedReference): void {
  view.dispatch({ effects: closePeek.of(null) })
  navigateTo(useAgentStore.getState().activeSessionId, { path: ref.path, line: ref.line, ch: ref.ch })
}

class PeekWidget extends WidgetType {
  constructor(readonly state: PeekState) {
    super()
  }
  // Same state object → reuse DOM; selection/refs change mints a new object.
  eq(other: PeekWidget): boolean {
    return other.state === this.state
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-refpeek'
    const header = document.createElement('div')
    header.className = 'cm-refpeek-header'
    header.textContent = `${this.state.refs.length} references${this.state.symbol ? ` to ${this.state.symbol}` : ''}`
    root.appendChild(header)
    this.state.refs.forEach((ref, i) => {
      const row = document.createElement('div')
      row.className = 'cm-refpeek-row' + (i === this.state.selected ? ' cm-refpeek-row-selected' : '')
      const loc = document.createElement('span')
      loc.className = 'cm-refpeek-loc'
      loc.textContent = `${ref.path}:${ref.line}`
      const prev = document.createElement('span')
      prev.className = 'cm-refpeek-prev'
      prev.textContent = ref.preview
      row.append(loc, prev)
      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        openRef(view, ref)
      })
      root.appendChild(row)
    })
    return root
  }
  ignoreEvent(): boolean {
    return false
  }
}

const peekDecorations = EditorView.decorations.compute([peekField], (state): DecorationSet => {
  const p = state.field(peekField)
  if (!p) return Decoration.none
  const line = state.doc.line(Math.min(Math.max(p.line, 1), state.doc.lines))
  return Decoration.set([
    Decoration.widget({ widget: new PeekWidget(p), block: true, side: 1 }).range(line.to),
  ])
})

const peekKeymap = Prec.highest(
  keymap.of([
    { key: 'Escape', run: (v) => (v.state.field(peekField) ? (v.dispatch({ effects: closePeek.of(null) }), true) : false) },
    { key: 'ArrowDown', run: (v) => (v.state.field(peekField) ? (v.dispatch({ effects: movePeek.of(1) }), true) : false) },
    { key: 'ArrowUp', run: (v) => (v.state.field(peekField) ? (v.dispatch({ effects: movePeek.of(-1) }), true) : false) },
    {
      key: 'Enter',
      run: (v) => {
        const p = v.state.field(peekField)
        if (!p) return false
        openRef(v, p.refs[p.selected])
        return true
      },
    },
  ]),
)

const peekTheme = EditorView.theme({
  '.cm-refpeek': {
    border: '1px solid var(--border)',
    borderLeft: '2px solid var(--accent)',
    background: 'var(--bg-secondary)',
    margin: '4px 0',
    maxHeight: '180px',
    overflowY: 'auto',
    fontSize: '12px',
  },
  '.cm-refpeek-header': {
    padding: '4px 10px',
    color: 'var(--text-muted)',
    borderBottom: '1px solid var(--border)',
    position: 'sticky',
    top: '0',
    background: 'var(--bg-secondary)',
  },
  '.cm-refpeek-row': { display: 'flex', gap: '10px', padding: '3px 10px', cursor: 'pointer', whiteSpace: 'nowrap' },
  '.cm-refpeek-row-selected': { background: 'var(--bg-hover)' },
  '.cm-refpeek-loc': { color: 'var(--accent)', fontFamily: 'var(--font-mono)', flexShrink: 0 },
  '.cm-refpeek-prev': { color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.8 },
})

export function referencesPeek(): Extension {
  return [peekField, peekDecorations, peekKeymap, peekTheme]
}

/** ⇧F12 - find references for the symbol under the cursor. */
export function runReferences(
  view: EditorView,
  getPath: () => string | null,
  getRepoRoot: () => string | null,
): void {
  const relPath = getPath()
  if (!relPath) return
  const repoRoot = getRepoRoot()
  const absPath =
    repoRoot && !relPath.startsWith('/') ? `${repoRoot}/${relPath}`.replace(/\/+/g, '/') : relPath
  const pos = view.state.selection.main.head
  const lineObj = view.state.doc.lineAt(pos)
  const symbol = wordAt(view, pos)?.word ?? ''
  const sessionId = useAgentStore.getState().activeSessionId
  void resolveReferences(absPath, { line: lineObj.number - 1, character: pos - lineObj.from }).then((refs) => {
    const action = referenceAction(refs.length)
    if (action === 'none') return
    // Record where we invoked from so back returns here after picking a ref.
    recordLocation(sessionId, relPath, lineObj.number)
    if (action === 'jump') {
      navigateTo(sessionId, { path: refs[0].path, line: refs[0].line, ch: refs[0].ch })
      return
    }
    view.dispatch({ effects: openPeek.of({ line: lineObj.number, refs, symbol }) })
  })
}
