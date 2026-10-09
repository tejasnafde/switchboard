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
 *     don't want for chat input - keeps the editor body as a flat
 *     stream of TextNodes + PillNodes + LineBreakNodes.
 *
 * What this component owns:
 *   - Editor state hydration FROM the host's string body on
 *     session-switch / external writes (slash command, ⌘L, "send to
 *     other panel" forward).
 *   - Plain-text serialization on every edit (string with `[[pill:id]]`
 *     tokens) so the host's draft-store stays string-shaped.
 *   - Caret offset tracking - used by `detectSlashTrigger` for the
 *     slash menu. We compute the caret as a 0-based offset into the
 *     plain-text representation by walking the editor tree.
 *   - Imperative `insertPill(pill)` via `INSERT_PILL_COMMAND` so ⌘L
 *     can insert at the live caret without going through the host.
 *
 * What it does NOT own:
 *   - The slash menu UI itself (host renders `<SlashCommandMenu>` over
 *     it). We just emit `onSlashTriggerChange` updates.
 *   - The footer (model picker, mode selector, Send button) - host
 *     keeps owning those.
 *   - Image paste - clipboardData files bubble to the host via the
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
  $createRangeSelection,
  $createRangeSelectionFromDom,
  $createNodeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_NORMAL,
  createCommand,
  FOCUS_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type BaseSelection,
  type EditorState,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  type PointType,
  type RangeSelection,
} from 'lexical'
import { $createPillNode, $isPillNode, PillContentContext, PillNode } from './PillNode'
import { parseBodyToSegments } from '../../../services/chat-input-body'
import { selectionToRestore, type ComposerSelection, type SavedComposerSelection } from '../../../services/composer-selection'
import type { DraftPill } from '../../../stores/draft-store'
import { createRendererLogger } from '../../../logger'
import { matchesShortcut } from '@shared/shortcuts'

const log = createRendererLogger('chat:lexical')

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
  /**
   * `caret` is the offset AFTER this change. It rides along because the
   * host's own caret state is one update behind inside its change handler
   * (both callbacks fire from the same Lexical update), which made a lone
   * `/` in an empty composer miss the slash-menu trigger.
   */
  onChange: (value: string, caret: number | null) => void
  onCaretChange?: (caret: number | null) => void
  /** `altKey` is true for Alt/Option+Enter (queue instead of steer). */
  onEnter?: (key: { altKey: boolean }) => void
  onPasteFiles?: (files: File[]) => void
  pillsById: Record<string, ComposerPill>
  placeholder?: string
  disabled?: boolean
  /** Forwarded to the contenteditable as a `data-*` attribute for ⌘F search etc. */
  dataAttrs?: Record<string, string>
  /** Right padding (a CSS length), so text and placeholder stop short of controls the host overlays on the box. */
  trailingInset?: string
}

/** What the editor needs of a pill; `content` feeds the chip's count and card. */
type ComposerPill = Pick<DraftPill, 'id' | 'label' | 'kind'> & Partial<Pick<DraftPill, 'content'>>

export const INSERT_PILL_COMMAND: LexicalCommand<DraftPill> = createCommand('INSERT_PILL')

/**
 * Build a Lexical paragraph node tree from the host's plain-text body.
 * Splits on `\n` (newline → LineBreakNode), and on `[[pill:id]]` tokens
 * (→ PillNode using the chip metadata from `pillsById`).
 *
 * Tokens whose ids are NOT in `pillsById` are dropped - they belong to
 * pills that have been removed; leaving the raw token string in the
 * editor would confuse the user.
 */
function $populateFromBody(
  body: string,
  pillsById: Record<string, ComposerPill>,
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
        // Drop unknown ids - see header comment.
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

function childrenOf(node: LexicalNode): LexicalNode[] | null {
  const anyNode = node as LexicalNode & { getChildren?: () => LexicalNode[] }
  return typeof anyNode.getChildren === 'function' ? anyNode.getChildren() : null
}

/** A node's length in the plain-text body, by the rules of serializeEditorToBody. */
function $bodyLength(node: LexicalNode): number {
  if (node.getType() === 'linebreak') return 1
  if ($isPillNode(node)) return node.getTextContent().length
  const kids = childrenOf(node)
  if (!kids) return node.getTextContent().length
  let n = 0
  for (const kid of kids) n += $bodyLength(kid)
  return n
}

/**
 * A selection point as a 0-based offset into the plain-text body. Walks the
 * editor in DOM order, summing node lengths until it reaches the point. Pills
 * count as their token length (`[[pill:id]]`) so the offset stays consistent
 * with what the host's slash detector sees. Must be called inside a read or
 * update.
 */
function $offsetOfPoint(point: PointType): number | null {
  const targetNode = point.getNode()
  let acc = 0
  let found = false
  // Depth-first walk that stops at the point's node. Comparing the point only
  // against the root's direct children missed a text node inside a paragraph
  // (the normal case while typing), so the caret read null.
  const walk = (node: LexicalNode): void => {
    if (found) return
    if (node === targetNode) {
      if (node.getType() === 'text') {
        acc += point.offset
      } else {
        // Element point: offset is a child index, so count the children
        // before it.
        const kids = childrenOf(node) ?? []
        for (let i = 0; i < point.offset && i < kids.length; i++) acc += $bodyLength(kids[i])
      }
      found = true
      return
    }
    const kids = node.getType() === 'linebreak' || $isPillNode(node) ? null : childrenOf(node)
    if (!kids) {
      acc += $bodyLength(node)
      return
    }
    for (const kid of kids) {
      walk(kid)
      if (found) return
    }
  }
  for (const child of $getRoot().getChildren()) {
    walk(child)
    if (found) break
  }
  return found ? acc : null
}

/** A selection (the current one by default) as body offsets, or null when it is not a range selection. */
function $selectionOffsets(sel: BaseSelection | null = $getSelection()): ComposerSelection | null {
  if (!$isRangeSelection(sel)) return null
  const anchor = $offsetOfPoint(sel.anchor)
  const focus = $offsetOfPoint(sel.focus)
  return anchor === null || focus === null ? null : { anchor, focus }
}

function caretOffsetFromSelection(editor: LexicalEditor): number | null {
  return editor.getEditorState().read(() => $selectionOffsets()?.anchor ?? null)
}

type PointSpec = { key: string; offset: number; type: 'text' | 'element' }

/**
 * The inverse of `$offsetOfPoint`. Inside a text node the point is a text
 * point; before a pill or a linebreak, or at the end of a paragraph, it is an
 * element point (a child index), so a position between two pills resolves
 * too. Null when the offset is past the end of the body.
 */
function $pointAtOffset(offset: number): PointSpec | null {
  let acc = 0
  const visit = (node: LexicalNode): PointSpec | null => {
    const kids = childrenOf(node)
    if (!kids) return null
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i]
      if (kid.getType() === 'text') {
        const len = kid.getTextContent().length
        if (offset <= acc + len) return { key: kid.getKey(), offset: offset - acc, type: 'text' }
        acc += len
      } else if (kid.getType() === 'linebreak' || $isPillNode(kid)) {
        if (offset === acc) return { key: node.getKey(), offset: i, type: 'element' }
        acc += $bodyLength(kid)
      } else {
        const inner = visit(kid)
        if (inner) return inner
      }
    }
    return offset === acc ? { key: node.getKey(), offset: kids.length, type: 'element' } : null
  }
  for (const child of $getRoot().getChildren()) {
    const point = visit(child)
    if (point) return point
  }
  return null
}

/**
 * Select `[anchor, focus]` of the plain-text body; a collapsed range places
 * the caret. An offset past the end of the body selects the end. Must be
 * called inside `editor.update()`.
 */
function $selectOffsets({ anchor, focus }: ComposerSelection): void {
  const a = $pointAtOffset(anchor)
  const f = anchor === focus ? a : $pointAtOffset(focus)
  if (!a || !f) {
    $getRoot().selectEnd()
    return
  }
  const sel = $createRangeSelection()
  sel.anchor.set(a.key, a.offset, a.type)
  sel.focus.set(f.key, f.offset, f.type)
  $setSelection(sel)
}

function $selectAtOffset(offset: number): void {
  $selectOffsets({ anchor: offset, focus: offset })
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
 * detect external writes - a typing-only update will already match.
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
    // intentionally only on mount - subsequent syncs handled below
  }, [])

  // External-write sync. If `value` changed AND it doesn't match the
  // editor's current body, repopulate. Otherwise skip - typing-driven
  // changes already produced this `value`.
  //
  // Capture the caret BEFORE repopulate and restore it AFTER. Without
  // this, picking a slash-command (which writes through `replaceRange`
  // → `setValue` → React re-render → this effect → `$populateFromBody`)
  // would land the caret at offset 0 every time, because Lexical's
  // default selection after a fresh root population is the start.
  //
  // An empty editor has no position worth keeping, so text written into one
  // (a failed send restoring its body) gets the caret at its end. Restoring
  // the empty editor's offset 0 put it before `/send-to`.
  useEffect(() => {
    if (value === lastValueRef.current) return
    const current = serializeEditorToBody(editor)
    lastValueRef.current = value
    if (value === current) return
    const priorCaret = caretOffsetFromSelection(editor)
    editor.update(() => {
      $populateFromBody(value, pillsById)
      if (priorCaret !== null) $selectAtOffset(current === '' ? value.length : priorCaret)
    })
  }, [value, pillsById, editor])

  return null
}

/**
 * Plugin: put the selection back when focus returns without a click. An
 * overlay closing (Settings, the palette, search, quick prompt) or a panel
 * refocusing its composer calls `element.focus()`, and the browser then puts
 * the caret at the start. The selection is saved while the editor has focus
 * and restored synchronously in the focus event, before the browser's
 * `selectionchange` reaches Lexical. A pointer press keeps the browser's
 * placement, since the click says where the caret goes.
 */
function SelectionMemoryPlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    let saved: SavedComposerSelection | null = null
    let pointerDown = false
    const onPointerDown = (): void => { pointerDown = true }
    const onPointerUp = (): void => { pointerDown = false }
    let rootEl: HTMLElement | null = null
    const removeRoot = editor.registerRootListener((root) => {
      rootEl?.removeEventListener('pointerdown', onPointerDown)
      rootEl = root
      rootEl?.addEventListener('pointerdown', onPointerDown)
    })
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    const save = (offsets: ComposerSelection | null): void => {
      if (offsets) saved = { ...offsets, body: serializeEditorToBody(editor) }
    }
    const removeUpdate = editor.registerUpdateListener(({ editorState }) => {
      const root = editor.getRootElement()
      if (!root || document.activeElement !== root) return
      editorState.read(() => save($selectionOffsets()))
    })
    // Lexical learns of a caret move only from a later `selectionchange`, so
    // a shortcut pressed right after an arrow key can blur the editor first.
    // The DOM selection is still current at blur: save from it.
    const removeBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        const dom = window.getSelection()
        const root = editor.getRootElement()
        if (dom && root?.contains(dom.anchorNode)) editor.read(() => save($selectionOffsets($createRangeSelectionFromDom(dom, editor))))
        return false
      },
      COMMAND_PRIORITY_LOW,
    )
    const removeFocus = editor.registerCommand(
      FOCUS_COMMAND,
      () => {
        if (pointerDown || !saved) return false
        const target = selectionToRestore(saved, serializeEditorToBody(editor))
        // Discrete: commit now, inside the focus event, so the DOM selection
        // is ours before the browser's selectionchange is read.
        editor.update(() => { $selectOffsets(target) }, { discrete: true })
        return false
      },
      COMMAND_PRIORITY_LOW,
    )
    return () => {
      removeRoot()
      rootEl?.removeEventListener('pointerdown', onPointerDown)
      removeUpdate()
      removeBlur()
      removeFocus()
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
    }
  }, [editor])
  return null
}

/** The pill right beside a collapsed caret, on the side an arrow key moves to. */
function $pillBesideCaret(selection: RangeSelection, backward: boolean): PillNode | null {
  if (!selection.isCollapsed()) return null
  const { anchor } = selection
  const node = anchor.getNode()
  let beside: LexicalNode | null = null
  if ($isTextNode(node)) {
    if (backward && anchor.offset === 0) beside = node.getPreviousSibling()
    else if (!backward && anchor.offset === node.getTextContentSize()) beside = node.getNextSibling()
  } else if ($isElementNode(node)) {
    beside = node.getChildAtIndex(backward ? anchor.offset - 1 : anchor.offset)
  }
  return $isPillNode(beside) ? beside : null
}

/**
 * Plugin: Left or Right arrow next to a chip selects it (a node selection,
 * drawn with a tinted ring) instead of jumping past it. The chip then takes
 * the keys (`PillChip` in PillNode). Shift extends text selection as before.
 */
function PillSelectPlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const select = (backward: boolean) => (event: KeyboardEvent): boolean => {
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) return false
      const pill = $pillBesideCaret(selection, backward)
      if (!pill) return false
      event.preventDefault()
      const nodeSelection = $createNodeSelection()
      nodeSelection.add(pill.getKey())
      $setSelection(nodeSelection)
      return true
    }
    const offLeft = editor.registerCommand(KEY_ARROW_LEFT_COMMAND, select(true), COMMAND_PRIORITY_NORMAL)
    const offRight = editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, select(false), COMMAND_PRIORITY_NORMAL)
    return () => { offLeft(); offRight() }
  }, [editor])
  return null
}

/**
 * Plugin: register Enter key handler so the host can intercept "send
 * on Enter". Shift+Enter falls through to Lexical's default (newline).
 */
function EnterKeyPlugin({ onEnter }: { onEnter?: (key: { altKey: boolean }) => void }): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    return editor.registerCommand<KeyboardEvent | null>(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event && event.shiftKey) return false // soft break (composer.newline)
        event?.preventDefault()
        onEnter?.({ altKey: !!event && matchesShortcut(event, 'composer.send-other') })
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

/** Reconstruct PillNodes from `[[pill:<id>]]` tokens on paste so cut/copy round-trips chips. */
function PasteTextPlugin({
  pillsById,
}: {
  pillsById: RichChatTextareaProps['pillsById']
}): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    return editor.registerCommand<ClipboardEvent>(
      PASTE_COMMAND,
      (event) => {
        // Files take precedence - handled by PasteFilesPlugin.
        if ((event.clipboardData?.files?.length ?? 0) > 0) return false
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (!text.includes('[[pill:')) return false
        event.preventDefault()
        const segs = parseBodyToSegments(text)
        editor.update(() => {
          const sel = $getSelection()
          if (!$isRangeSelection(sel)) return
          const nodes: LexicalNode[] = []
          for (const seg of segs) {
            if (seg.type === 'text') {
              if (seg.text.length === 0) continue
              const lines = seg.text.split('\n')
              for (let i = 0; i < lines.length; i++) {
                if (i > 0) nodes.push($createLineBreakNode())
                if (lines[i].length > 0) nodes.push($createTextNode(lines[i]))
              }
            } else {
              const meta = pillsById[seg.id]
              if (meta) nodes.push($createPillNode(meta.id, meta.label, meta.kind))
            }
          }
          if (nodes.length > 0) $insertNodes(nodes)
        })
        return true
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor, pillsById])
  return null
}

/**
 * Plugin: expose imperative methods (focus, blur, insertPill,
 * replaceRange, getCaret) to the host via the forwarded ref.
 */
const ImperativeHandlePlugin = forwardRef<
  RichChatTextareaHandle,
  { pillsById: RichChatTextareaProps['pillsById']; getValue: () => string }
>(function ImperativeHandlePlugin({ pillsById, getValue }, ref): null {
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
        // Do NOT call `setValue(next)` alongside this update - that races
        // HydrationPlugin into restoring a stale caret (= 0 for slash
        // commands at the start of an empty input). OnChangePlugin will
        // propagate the new body via onChange after commit; pinned by
        // tests/unit/rich-chat-textarea-replace.test.ts.
        editor.update(() => {
          $populateFromBody(next, pillsById)
          $selectAtOffset(start + replacement.length)
        })
      },
      getCaret: () => caretOffsetFromSelection(editor),
    }),
    [editor, getValue, pillsById],
  )
  return null
})

const editorTheme = {
  paragraph: 'sb-rci-paragraph',
}

function onError(err: Error): void {
  log.error('Lexical editor error:', err)
}

/** One line of text plus padding and border, so the box has a known one-line height. Keep in step with `min-h-[42px]` below. */
export const RICH_TEXTAREA_MIN_HEIGHT = 42

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
      trailingInset = '12px',
    } = props

    const valueRef = useRef(value)
    valueRef.current = value
    const pillContent = useCallback((id: string) => pillsById[id]?.content, [pillsById])
    // The host computes the right inset, so it reaches the classes as a variable.
    const insetStyle = { '--sb-rci-inset': trailingInset } as React.CSSProperties

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
      [],
    )

    const handleChange = useCallback(
      (editorState: EditorState, editor: LexicalEditor) => {
        const body = serializeEditorToBody(editor)
        const caret = caretOffsetFromSelection(editor)
        if (body !== valueRef.current) {
          valueRef.current = body
          onChange(body, caret)
        }
        onCaretChange?.(caret)
      },
      [onChange, onCaretChange],
    )

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <PillContentContext.Provider value={pillContent}>
          <EditableSync disabled={disabled} />
          <HydrationPlugin value={value} pillsById={pillsById} />
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                {...(dataAttrs ?? {})}
                spellCheck={false}
                aria-label="Chat message"
                data-placeholder={placeholder}
                className="sb-rci-content flex-1 resize-none py-[10px] pl-[12px] pr-[var(--sb-rci-inset)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-[13px] [font-family:var(--font-sans)] leading-[1.5] outline-none max-h-[200px] overflow-y-auto min-h-[42px] whitespace-pre-wrap [word-break:break-word]"
                style={insetStyle}
              />
            }
            placeholder={
              <div
                className="sb-rci-placeholder absolute top-[10px] left-[12px] right-[var(--sb-rci-inset)] truncate text-[var(--text-muted)] pointer-events-none text-[13px] [font-family:var(--font-sans)]"
                style={insetStyle}
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
          <PasteTextPlugin pillsById={pillsById} />
          <PillInsertPlugin />
          <PillSelectPlugin />
          <SelectionMemoryPlugin />
          <ImperativeHandlePlugin
            ref={ref}
            pillsById={pillsById}
            getValue={() => valueRef.current}
          />
        </PillContentContext.Provider>
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
