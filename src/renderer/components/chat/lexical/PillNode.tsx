/**
 * Inline chip node for the rich chat input.
 *
 * `PillNode` is a Lexical `DecoratorNode` - it renders custom React
 * (the chip) but participates in the editor's text/selection model
 * like any other inline node. That's the whole reason we picked
 * Lexical over a hand-rolled contenteditable: DecoratorNodes get IME
 * composition, undo/redo, paste sanitization, and Firefox-`<br>`
 * weirdness handled by the framework.
 *
 * Wire format: a PillNode contributes `[[pill:<id>]]` to
 * `getTextContent()`, so the editor's plain-text view round-trips
 * through `parseBodyToSegments` / `serializeBodyWithPills` without
 * any extra glue.
 *
 * Visuals: `PillChipVisual`, the same chip the sent bubble draws. The
 * arrow keys select a chip (a Lexical node selection, see
 * `PillSelectPlugin` in RichChatTextarea), and the chip handles the keys
 * while it is selected.
 */
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  COMMAND_PRIORITY_HIGH,
  DecoratorNode,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_SPACE_COMMAND,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection'
import { createContext, useContext, useEffect, useState, type JSX } from 'react'
import type { DraftPillKind } from '../../../stores/draft-store'
import { pillChipModel } from '../../../services/pill-chip-model'
import { openPillFromElement, PillChipVisual } from './PillChipVisual'

export type SerializedPillNode = Spread<
  {
    pillId: string
    label: string
    kind: DraftPillKind
  },
  SerializedLexicalNode
>

/** The text a composer pill expands to, by pill id. The node itself stores only label and kind. */
export const PillContentContext = createContext<(pillId: string) => string | undefined>(() => undefined)

/** Remove a pill node and tell the host to drop its metadata, leaving the caret where it was. */
function removePillNode(editor: LexicalEditor, nodeKey: NodeKey, pillId: string): void {
  editor.update(() => {
    const node = $getNodeByKey(nodeKey)
    if (!node) return
    if ($isNodeSelection($getSelection())) node.selectPrevious()
    node.remove()
  })
  window.dispatchEvent(new CustomEvent('sb-pill-remove', { detail: { id: pillId } }))
}

interface PillChipProps {
  pillId: string
  label: string
  kind: DraftPillKind
  nodeKey: NodeKey
}

function PillChip({ pillId, label, kind, nodeKey }: PillChipProps): JSX.Element {
  const [editor] = useLexicalComposerContext()
  const content = useContext(PillContentContext)(pillId)
  const [isSelected] = useLexicalNodeSelection(nodeKey)
  const [cardOpen, setCardOpen] = useState(false)

  useEffect(() => {
    if (!isSelected) setCardOpen(false)
  }, [isSelected])

  // Keys on a chip selected with the arrow keys: Backspace or Delete removes
  // it, Space toggles its card, Enter opens its source, the arrows leave it,
  // and a typed character goes after it.
  useEffect(() => {
    if (!isSelected) return
    const onlyThis = (): boolean => {
      const selection = $getSelection()
      return $isNodeSelection(selection) && selection.getNodes().length === 1 && selection.has(nodeKey)
    }
    const leave = (backward: boolean) => (event: KeyboardEvent | null): boolean => {
      if (!onlyThis() || event?.shiftKey) return false
      event?.preventDefault()
      const node = $getNodeByKey(nodeKey)
      if (!node) return false
      if (backward) node.selectPrevious()
      else node.selectNext(0, 0)
      return true
    }
    const remove = (event: KeyboardEvent | null): boolean => {
      if (!onlyThis()) return false
      event?.preventDefault()
      removePillNode(editor, nodeKey, pillId)
      return true
    }
    const unregister = [
      editor.registerCommand(KEY_BACKSPACE_COMMAND, remove, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_DELETE_COMMAND, remove, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_LEFT_COMMAND, leave(true), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, leave(false), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_SPACE_COMMAND, (event) => {
        if (!onlyThis()) return false
        event.preventDefault()
        setCardOpen((open) => !open)
        return true
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ESCAPE_COMMAND, (event) => {
        if (!onlyThis() || !cardOpen) return false
        event.preventDefault()
        setCardOpen(false)
        return true
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
        if (!onlyThis() || event?.shiftKey) return false
        const model = pillChipModel({ kind, label, content })
        if (!model.target) return false
        event?.preventDefault()
        setCardOpen(false)
        openPillFromElement(model, editor.getElementByKey(nodeKey))
        return true
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
        if (!onlyThis() || event.key.length !== 1 || event.key === ' ' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false
        event.preventDefault()
        const node = $getNodeByKey(nodeKey)
        if (!node) return false
        const after = node.selectNext(0, 0)
        after.insertText(event.key)
        return true
      }, COMMAND_PRIORITY_HIGH),
    ]
    return () => unregister.forEach((off) => off())
  }, [editor, isSelected, cardOpen, nodeKey, pillId, kind, label, content])

  return (
    <PillChipVisual
      label={label}
      kind={kind}
      content={content}
      selectable={false}
      selected={isSelected}
      cardOpen={cardOpen}
      onCardOpenChange={setCardOpen}
      onRemove={() => removePillNode(editor, nodeKey, pillId)}
      rootProps={{
        'data-pill-id': pillId,
        // contentEditable=false: without it, Lexical lets the user type
        // inside the chip and chaos ensues.
        contentEditable: false,
      }}
    />
  )
}

export class PillNode extends DecoratorNode<JSX.Element> {
  __pillId: string
  __label: string
  __kind: DraftPillKind

  static getType(): string {
    return 'sb-pill'
  }

  static clone(node: PillNode): PillNode {
    return new PillNode(node.__pillId, node.__label, node.__kind, node.__key)
  }

  constructor(pillId: string, label: string, kind: DraftPillKind, key?: NodeKey) {
    super(key)
    this.__pillId = pillId
    this.__label = label
    this.__kind = kind
  }

  /** Pill id is what survives serialization - label + kind are looked up at render time. */
  getPillId(): string { return this.__pillId }
  getLabel(): string { return this.__label }
  getKindValue(): DraftPillKind { return this.__kind }

  /**
   * `getTextContent` is what `$getRoot().getTextContent()` walks, and it's
   * what `detectSlashTrigger` / `serializeBodyWithPills` see. We emit the
   * exact `[[pill:<id>]]` token that `parseBodyToSegments` reverses.
   */
  getTextContent(): string {
    return `[[pill:${this.__pillId}]]`
  }

  isInline(): boolean { return true }
  isKeyboardSelectable(): boolean { return true }
  // Treat the chip as one indivisible unit - Backspace deletes the whole
  // pill, arrow keys jump past it. Without this, users could caret-into
  // the empty chip and get stuck.
  isIsolated(): boolean { return true }

  createDOM(_config: EditorConfig): HTMLElement {
    // Span so the chip flows inline with surrounding text.
    const span = document.createElement('span')
    span.style.display = 'inline'
    return span
  }

  updateDOM(): false { return false }

  decorate(): JSX.Element {
    return (
      <PillChip
        pillId={this.__pillId}
        label={this.__label}
        kind={this.__kind}
        nodeKey={this.__key}
      />
    )
  }

  static importJSON(serialized: SerializedPillNode): PillNode {
    return new PillNode(serialized.pillId, serialized.label, serialized.kind)
  }

  exportJSON(): SerializedPillNode {
    return {
      type: PillNode.getType(),
      version: 1,
      pillId: this.__pillId,
      label: this.__label,
      kind: this.__kind,
    }
  }
}

export function $createPillNode(pillId: string, label: string, kind: DraftPillKind): PillNode {
  return new PillNode(pillId, label, kind)
}

export function $isPillNode(node: LexicalNode | null | undefined): node is PillNode {
  return node instanceof PillNode
}
