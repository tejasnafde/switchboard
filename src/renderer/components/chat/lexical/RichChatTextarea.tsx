/**
 * Drop-in replacement for the chat input's `<textarea>`, but built on
 * Lexical so we can render inline pill chips at the caret position
 * (Cursor-style). The host (`ChatInput`) hands us a string body
 * containing `[[pill:<id>]]` tokens; we hydrate the editor to render
 * pills as `PillNode` decorators in-place. On every edit we hand the
 * string body back via `onChange` so the existing draft-store, slash
 * detection, and Send pipeline keep working unchanged.
 *
 * Why Lexical (and not raw contenteditable):
 *   - DecoratorNodes give us a React-rendered chip that the editor's
 *     selection model treats as a single indivisible unit (arrows
 *     skip past it, Backspace deletes it whole).
 *   - IME composition, undo/redo, and paste sanitization are framework
 *     concerns we don't need to re-derive.
 *   - PlainTextPlugin disables rich formatting (bold/italic) which we
 *     don't want for chat input — keeps the editor body as a flat
 *     stream of TextNodes + PillNodes + LineBreakNodes.
 *
 * What this component owns:
 *   - Editor state hydration FROM the host's string body on
 *     session-switch / external writes (slash command, ⌘L, "send to
 *     other panel" forward).
 *   - Plain-text serialization on every edit (string with `[[pill:id]]`
 *     tokens) so the host's draft-store stays string-shaped.
 *   - Caret offset tracking — used by `detectSlashTrigger` for the
 *     slash menu. We compute the caret as a 0-based offset into the
 *     plain-text representation by walking the editor tree.
 *   - Imperative `insertPill(pill)` via `INSERT_PILL_COMMAND` so ⌘L
 *     can insert at the live caret without going through the host.
 *
 * What it does NOT own:
 *   - The slash menu UI itself (host renders `<SlashCommandMenu>` over
 *     it). We just emit `onSlashTriggerChange` updates.
 *   - The footer (model picker, mode selector, Send button) — host
 *     keeps owning those.
 *   - Image paste — clipboardData files bubble to the host via the
 *     existing `onPaste` prop; we only intercept the *text* portion.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  createCommand,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type EditorState,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { $createPillNode, $isPillNode, PillNode } from './PillNode'
import { parseBodyToSegments } from '../../../services/chatInputBody'
import type { DraftPill } from '../../../stores/draft-store'

/** Imperative handle the host can grab to focus / insert pills. */
export interface RichChatTextareaHandle {
  focus: () => void
  blur: () => void
  insertPill: (pill: DraftPill) => void
  /** Replace `[start..end]` of the plain text with `replacement`. */
  replaceRange: (start: number, end: number, replacement: string) => void
  /** Current caret offset into plain text (or null if no selection). */
  getCaret: () => number | null
}

interface RichChatTextareaProps {
  value: string
  onChange: (value: string) => void
  onCaretChange?: (caret: number | null) => void
  onEnter?: () => void
  onPasteFiles?: (files: File[]) => void
  pillsById: Record<string, Pick<DraftPill, 'id' | 'label' | 'kind'>>
  placeholder?: string
  disabled?: boolean
  /** Forwarded to the contenteditable as a `data-*` attribute for ⌘F search etc. */
  dataAttrs?: Record<string, string>
}

export const INSERT_PILL_COMMAND: LexicalCommand<DraftPill> = createCommand('INSERT_PILL')

/**
 * Build a Lexical paragraph node tree from the host's plain-text body.
 * Splits on `\n` (newline → LineBreakNode), and on `[[pill:id]]` tokens
 * (→ PillNode using the chip metadata from `pillsById`).
 *
 * Tokens whose ids are NOT in `pillsById` are dropped — they belong to
 * pills that have been removed; leaving the raw token string in the
 * editor would confuse the user.
 */
function $populateFromBody(
  body: string,
  pillsById: Record<string, Pick<DraftPill, 'id' | 'label' | 'kind'>>,
): void {
  const root = $getRoot()
  root.clear()
  const paragraph = $createParagraphNode()
  root.append(paragraph)
  if (!body) return

  // Split body around literal `\n` so we can insert LineBreakNodes (Lexical
  // paragraphs treat `\n` inside a TextNode as collapsed; we want real soft
  // breaks for Shift+Enter to work as the user expects).
  const lines = body.split('\n')
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    if (lineIdx > 0) {
      // Emit a soft break between lines so Shift+Enter round-trips.
      paragraph.append($createLineBreakNode())
    }
    const segs = parseBodyToSegments(lines[lineIdx])
    for (const seg of segs) {
      if (seg.type === 'text') {
        if (seg.text.length > 0) paragraph.append($createTextNode(seg.text))
      } else {
        const meta = pillsById[seg.id]
        if (meta) paragraph.append($createPillNode(meta.id, meta.label, meta.kind))
        // Drop unknown ids — see header comment.
      }
    }
  }
}

/**
 * Walk the editor's children in order and build the plain-text body
 * (TextNodes contribute their text; PillNodes contribute their token;
 * LineBreakNodes contribute `\n`). This is what we hand back to the
 * host on every edit.
 */
function serializeEditorToBody(editor: LexicalEditor): string {
  let out = ''
  editor.getEditorState().read(() => {
    const root = $getRoot()
    const visit = (node: LexicalNode): void => {
      if (node.getType() === 'linebreak') { out += '\n'; return }
      if ($isPillNode(node)) { out += node.getTextContent(); return }
      // ElementNode: recurse into children.
      const anyNode = node as LexicalNode & { getChildren?: () => LexicalNode[]; getTextContent?: () => string }
      if (typeof anyNode.getChildren === 'function') {
        for (const child of anyNode.getChildren()) visit(child)
      } else {
        out += node.getTextContent()
      }
    }
    for (const child of root.getChildren()) {
      visit(child)
    }
  })
  return out
}

/**
 * Compute the caret as a 0-based offset into the plain-text body. We
 * walk the editor in DOM order, summing node lengths until we hit the
 * selection's anchor. Pills count as their token length (`[[pill:id]]`)
 * so the offset stays consistent with what the host's slash detector
 * sees.
 */
function caretOffsetFromSelection(editor: LexicalEditor): number | null {
  let caret: number | null = null
  editor.getEditorState().read(() => {
    const sel = $getSelection()
    if (!$isRangeSelection(sel)) return
    const anchor = sel.anchor
    const targetNode = anchor.getNode()
    let acc = 0
    let found = false
    const visit = (node: LexicalNode): void => {
      if (found) return
      if (node === targetNode) {
        // For text nodes, anchor.offset is char offset within the node.
        // For element nodes (e.g. paragraph when caret is between
        // children), anchor.offset is the child index — sum lengths of
        // children before that index.
        if (node.getType() === 'text') {
          acc += anchor.offset
          found = true
          return
        }
        const anyNode = node as LexicalNode & { getChildren?: () => LexicalNode[] }
        if (typeof anyNode.getChildren === 'function') {
          const kids = anyNode.getChildren()
          for (let i = 0; i < anchor.offset && i < kids.length; i++) {
            visitForLength(kids[i])
          }
          found = true
          return
        }
        found = true
        return
      }
      visitForLength(node)
    }
    const visitForLength = (node: LexicalNode): void => {
      if (node.getType() === 'linebreak') { acc += 1; return }
      if ($isPillNode(node)) { acc += node.getTextContent().length; return }
      const anyNode = node as LexicalNode & { getChildren?: () => LexicalNode[] }
      if (typeof anyNode.getChildren === 'function') {
        for (const child of anyNode.getChildren()) visitForLength(child)
      } else {
        acc += node.getTextContent().length
      }
    }
    for (const child of $getRoot().getChildren()) {
      visit(child)
      if (found) break
    }
    caret = found ? acc : null
  })
  return caret
}

/**
 * Plugin: registers `INSERT_PILL_COMMAND`. Inserts a PillNode at the
 * current selection, splitting any text node it lands inside.
 */
function PillInsertPlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    return editor.registerCommand<DraftPill>(
      INSERT_PILL_COMMAND,
      (pill) => {
        editor.update(() => {
          const sel = $getSelection()
          if (!$isRangeSelection(sel)) return
          const pillNode = $createPillNode(pill.id, pill.label, pill.kind)
          const spaceBefore = $createTextNode(' ')
          const spaceAfter = $createTextNode(' ')
          // Inserting whitespace + pill + whitespace mirrors
          // `insertPillAtCursor`'s arithmetic so the editor body string
          // and the pure helper agree on the result. Lexical's
          // `$insertNodes` handles the split-and-stitch automatically.
          $insertNodes([spaceBefore, pillNode, spaceAfter])
        })
        return true
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor])
  return null
}

/**
 * Plugin: hydrate editor from the host's `value` prop on first mount
 * and on EXTERNAL changes (where `value` doesn't match what the editor
 * is currently showing). We compare to the editor's serialized body to
 * detect external writes — a typing-only update will already match.
 */
function HydrationPlugin({
  value,
  pillsById,
}: {
  value: string
  pillsById: RichChatTextareaProps['pillsById']
}): null {
  const [editor] = useLexicalComposerContext()
  const lastValueRef = useRef<string | null>(null)

  // First mount populate.
  useEffect(() => {
    editor.update(() => {
      $populateFromBody(value, pillsById)
    })
    lastValueRef.current = value
    // intentionally only on mount — subsequent syncs handled below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // External-write sync. If `value` changed AND it doesn't match the
  // editor's current body, repopulate. Otherwise skip — typing-driven
  // changes already produced this `value`.
  useEffect(() => {
    if (value === lastValueRef.current) return
    const current = serializeEditorToBody(editor)
    lastValueRef.current = value
    if (value === current) return
    editor.update(() => {
      $populateFromBody(value, pillsById)
    })
  }, [value, pillsById, editor])

  return null
}

/**
 * Plugin: register Enter key handler so the host can intercept "send
 * on Enter". Shift+Enter falls through to Lexical's default (newline).
 */
function EnterKeyPlugin({ onEnter }: { onEnter?: () => void }): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    return editor.registerCommand<KeyboardEvent | null>(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event && event.shiftKey) return false // soft break
        event?.preventDefault()
        onEnter?.()
        return true
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor, onEnter])
  return null
}

/**
 * Plugin: forward image-file pastes to the host. PlainTextPlugin
 * already strips HTML, so we only need to extract `clipboardData.files`.
 */
function PasteFilesPlugin({ onPasteFiles }: { onPasteFiles?: (files: File[]) => void }): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    if (!onPasteFiles) return
    return editor.registerCommand<ClipboardEvent>(
      PASTE_COMMAND,
      (event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        const images = files.filter((f) => f.type.startsWith('image/'))
        if (images.length === 0) return false
        event.preventDefault()
        onPasteFiles(images)
        return true
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor, onPasteFiles])
  return null
}

/**
 * Plugin: expose imperative methods (focus, blur, insertPill,
 * replaceRange, getCaret) to the host via the forwarded ref.
 */
const ImperativeHandlePlugin = forwardRef<
  RichChatTextareaHandle,
  { pillsById: RichChatTextareaProps['pillsById']; getValue: () => string; setValue: (v: string) => void }
>(function ImperativeHandlePlugin({ pillsById, getValue, setValue }, ref): null {
  const [editor] = useLexicalComposerContext()
  useImperativeHandle(
    ref,
    () => ({
      focus: () => { editor.focus() },
      blur: () => { editor.blur() },
      insertPill: (pill) => { editor.dispatchCommand(INSERT_PILL_COMMAND, pill) },
      replaceRange: (start, end, replacement) => {
        const cur = getValue()
        const next = cur.slice(0, start) + replacement + cur.slice(end)
        setValue(next)
        editor.update(() => { $populateFromBody(next, pillsById) })
      },
      getCaret: () => caretOffsetFromSelection(editor),
    }),
    [editor, getValue, setValue, pillsById],
  )
  return null
})

const editorTheme = {
  paragraph: 'sb-rci-paragraph',
}

function onError(err: Error): void {
  // Surface to console so devtools catches it; don't blow up the app.
  // eslint-disable-next-line no-console
  console.error('[RichChatTextarea]', err)
}

export const RichChatTextarea = forwardRef<RichChatTextareaHandle, RichChatTextareaProps>(
  function RichChatTextarea(props, ref): React.ReactElement {
    const {
      value,
      onChange,
      onCaretChange,
      onEnter,
      onPasteFiles,
      pillsById,
      placeholder = 'Message the agent...',
      disabled = false,
      dataAttrs,
    } = props

    const valueRef = useRef(value)
    valueRef.current = value

    const initialConfig = useMemo(
      () => ({
        namespace: 'sb-chat-input',
        nodes: [PillNode],
        editable: !disabled,
        theme: editorTheme,
        onError,
      }),
      // intentionally stable: passing a fresh config remounts the editor
      // and loses focus mid-typing. Editability is updated below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    )

    const handleChange = useCallback(
      (editorState: EditorState, editor: LexicalEditor) => {
        const body = serializeEditorToBody(editor)
        if (body !== valueRef.current) {
          valueRef.current = body
          onChange(body)
        }
        const caret = caretOffsetFromSelection(editor)
        onCaretChange?.(caret)
      },
      [onChange, onCaretChange],
    )

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <EditableSync disabled={disabled} />
        <HydrationPlugin value={value} pillsById={pillsById} />
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              {...(dataAttrs ?? {})}
              spellCheck={false}
              aria-label="Chat message"
              data-placeholder={placeholder}
              className="sb-rci-content"
              style={{
                flex: 1,
                resize: 'none',
                padding: '10px 12px',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                fontSize: '13px',
                fontFamily: 'var(--font-sans)',
                lineHeight: 1.5,
                outline: 'none',
                maxHeight: '200px',
                overflowY: 'auto',
                minHeight: '38px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            />
          }
          placeholder={
            <div
              className="sb-rci-placeholder"
              style={{
                position: 'absolute',
                top: '10px',
                left: '12px',
                color: 'var(--text-muted)',
                pointerEvents: 'none',
                fontSize: '13px',
                fontFamily: 'var(--font-sans)',
              }}
            >
              {placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin onChange={handleChange} />
        <EnterKeyPlugin onEnter={onEnter} />
        <PasteFilesPlugin onPasteFiles={onPasteFiles} />
        <PillInsertPlugin />
        <ImperativeHandlePlugin
          ref={ref}
          pillsById={pillsById}
          getValue={() => valueRef.current}
          setValue={(v) => { valueRef.current = v; onChange(v) }}
        />
      </LexicalComposer>
    )
  },
)

/** Toggle editor.editable when disabled prop changes. */
function EditableSync({ disabled }: { disabled: boolean }): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    editor.setEditable(!disabled)
  }, [editor, disabled])
  return null
}
