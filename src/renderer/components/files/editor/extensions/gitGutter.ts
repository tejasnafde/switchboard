/**
 * CM6 gutter extension that paints a colored bar (3px wide) per line
 * based on diff hunks fetched via `git:file-diff`. The hunks live in a
 * StateField so updates are a `dispatch({ effects })` away — no rebuild.
 *
 * Colors:
 *   - add → green
 *   - mod → yellow
 *   - del → red (single-line marker on the line *after* the deletion)
 *
 * The gutter doesn't fetch on its own; the editor host (or a small
 * orchestrator hook) calls `setHunks()` after save / on focus regain.
 */
import { StateEffect, StateField, RangeSetBuilder } from '@codemirror/state'
import { EditorView, gutter, GutterMarker } from '@codemirror/view'

export interface GutterHunk {
  kind: 'add' | 'mod' | 'del'
  startLine: number
  endLine: number
}

export const setHunksEffect = StateEffect.define<GutterHunk[]>()

const hunksField = StateField.define<GutterHunk[]>({
  create: () => [],
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setHunksEffect)) return e.value
    }
    return value
  },
})

class HunkMarker extends GutterMarker {
  constructor(private readonly kind: 'add' | 'mod' | 'del') { super() }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = `cm-gitgutter cm-gitgutter-${this.kind}`
    return el
  }
}

const ADD_MARK = new HunkMarker('add')
const MOD_MARK = new HunkMarker('mod')
const DEL_MARK = new HunkMarker('del')

const gutterTheme = EditorView.theme({
  '.cm-gitgutter': {
    width: '3px',
    height: '100%',
    marginLeft: '4px',
  },
  '.cm-gitgutter-add': { backgroundColor: '#3fb950' },
  '.cm-gitgutter-mod': { backgroundColor: '#d29922' },
  '.cm-gitgutter-del': { backgroundColor: '#f85149' },
})

export function gitGutter() {
  return [
    hunksField,
    gutter({
      class: 'cm-gitgutter-track',
      lineMarker: (view, blockInfo) => {
        const line = view.state.doc.lineAt(blockInfo.from).number
        const hunks = view.state.field(hunksField, false) ?? []
        for (const h of hunks) {
          if (line >= h.startLine && line <= h.endLine) {
            if (h.kind === 'add') return ADD_MARK
            if (h.kind === 'mod') return MOD_MARK
            return DEL_MARK
          }
        }
        return null
      },
      initialSpacer: () => ADD_MARK,
    }),
    gutterTheme,
  ]
}
