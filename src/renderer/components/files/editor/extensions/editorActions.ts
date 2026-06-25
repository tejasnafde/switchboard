/**
 * Editor-scoped action keymap (only fires when the CM editor is focused, so it
 * can't collide with app-global shortcuts):
 *   - F12      → go to definition of the symbol under the cursor
 *   - Ctrl-G   → go to line (VS Code's macOS binding; ⌘G is find-next)
 *
 * Comment toggle (⌘/), move/copy line (⌥↑↓ / ⇧⌥↑↓), and multi-cursor (⌘D)
 * already come from the bundled defaultKeymap/searchKeymap in `buildExtensions`.
 */
import { keymap } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'
import { gotoLine } from '@codemirror/search'
import { jumpToDefinitionAtCursor } from './cmdClickJump'
import { runReferences } from './referencesPeek'

export function editorActionsKeymap(
  getPath: () => string | null,
  getRepoRoot: () => string | null,
): Extension {
  return Prec.high(
    keymap.of([
      {
        key: 'F12',
        run: (view) => {
          jumpToDefinitionAtCursor(view, getPath, getRepoRoot)
          return true
        },
      },
      {
        key: 'Shift-F12',
        run: (view) => {
          runReferences(view, getPath, getRepoRoot)
          return true
        },
      },
      { key: 'Ctrl-g', run: gotoLine },
    ]),
  )
}
