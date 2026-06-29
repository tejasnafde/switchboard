/**
 * Rainbow indent guides - each indentation level gets a subtly-tinted
 * background, cycling through 4 colours. Works with both spaces and tabs.
 * Only the visible viewport is decorated, so large files have no overhead.
 */
import { ViewPlugin, Decoration, EditorView } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { getIndentUnit } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'

const LEVEL_COUNT = 4

// Pre-built mark decorations - avoids per-line object allocation
const levelMarks = [
  Decoration.mark({ class: 'cm-rainbowIndent-0' }),
  Decoration.mark({ class: 'cm-rainbowIndent-1' }),
  Decoration.mark({ class: 'cm-rainbowIndent-2' }),
  Decoration.mark({ class: 'cm-rainbowIndent-3' }),
]

// Colours intentionally low-opacity so they don't fight syntax highlighting.
// Same values on dark and light - at ~0.10 opacity they read fine on both.
const rainbowTheme = EditorView.baseTheme({
  '.cm-rainbowIndent-0': { backgroundColor: 'rgba(255,210,40,0.10)' },
  '.cm-rainbowIndent-1': { backgroundColor: 'rgba(60,210,100,0.10)' },
  '.cm-rainbowIndent-2': { backgroundColor: 'rgba(180,90,255,0.10)' },
  '.cm-rainbowIndent-3': { backgroundColor: 'rgba(40,200,230,0.10)' },
})

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { state } = view
  const indentSize = Math.max(1, getIndentUnit(state))
  const { from, to } = view.viewport

  for (
    let linePos = state.doc.lineAt(from).from;
    linePos <= to;
  ) {
    const line = state.doc.lineAt(linePos)
    const { text, from: lineFrom } = line
    let pos = 0
    let level = 0
    let spaceRun = 0

    while (pos < text.length) {
      const ch = text[pos]
      if (ch === ' ') {
        spaceRun++
        pos++
        if (spaceRun === indentSize) {
          builder.add(
            lineFrom + pos - indentSize,
            lineFrom + pos,
            levelMarks[level % LEVEL_COUNT],
          )
          level++
          spaceRun = 0
        }
      } else if (ch === '\t') {
        // Each tab counts as one indent level regardless of visual tab width
        spaceRun = 0
        builder.add(lineFrom + pos, lineFrom + pos + 1, levelMarks[level % LEVEL_COUNT])
        level++
        pos++
      } else {
        break
      }
    }

    linePos = line.to + 1
  }

  return builder.finish()
}

class RainbowIndentPlugin {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildDecorations(update.view)
    }
  }
}

export function rainbowIndent(): Extension[] {
  return [
    rainbowTheme,
    ViewPlugin.fromClass(RainbowIndentPlugin, {
      decorations: (v) => v.decorations,
    }),
  ]
}
