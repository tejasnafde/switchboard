/**
 * Inline chip node for the rich chat input.
 *
 * `PillNode` is a Lexical `DecoratorNode` — it renders custom React
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
 * Visuals: same colored-dot + label + × pattern as the previous
 * above-textarea chip row, just inline at the caret position. Tint
 * varies by `kind` (file=blue, terminal=amber, chat-message=purple).
 */
import { $getNodeByKey, DecoratorNode, type EditorConfig, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import type { JSX } from 'react'
import type { DraftPillKind } from '../../../stores/draft-store'

export type SerializedPillNode = Spread<
  {
    pillId: string
    label: string
    kind: DraftPillKind
  },
  SerializedLexicalNode
>

function tintForKind(kind: DraftPillKind): string {
  if (kind === 'file') return 'var(--accent, #58a6ff)'
  if (kind === 'terminal') return '#d29922'
  return '#8957e5'
}

interface PillChipProps {
  pillId: string
  label: string
  kind: DraftPillKind
  nodeKey: NodeKey
}

function PillChip({ pillId, label, kind, nodeKey }: PillChipProps): JSX.Element {
  const [editor] = useLexicalComposerContext()
  const handleRemove = (): void => {
    // Self-removal: locate this node by key and detach. Editor's onChange
    // fires → host re-serializes the body, which now lacks this pill's
    // token. We also notify the host via a window event so it can prune
    // the chip metadata from `pillsBySession`.
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if (node) node.remove()
    })
    window.dispatchEvent(new CustomEvent('sb-pill-remove', { detail: { id: pillId } }))
  }
  const tint = tintForKind(kind)
  return (
    <span
      title={label}
      data-pill-chip="true"
      data-pill-id={pillId}
      // contentEditable=false is critical: without it, Lexical lets the
      // user type inside the chip and chaos ensues. DecoratorNode wraps
      // us in a non-editable host, but explicit doesn't hurt.
      contentEditable={false}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 4px 0 6px',
        margin: '0 2px',
        borderRadius: '4px',
        background: 'var(--bg-tertiary)',
        border: `1px solid ${tint}33`,
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        verticalAlign: 'baseline',
        lineHeight: '1.4',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        maxWidth: '260px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      <span style={{ width: 4, height: 4, borderRadius: '50%', background: tint, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRemove() }}
        // Prevent focus stealing — without this, clicking × moves focus
        // out of the editor and the user has to re-click into the chip.
        onMouseDown={(e) => e.preventDefault()}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          padding: '0 1px',
          lineHeight: 1,
          fontSize: '13px',
        }}
      >
        ×
      </button>
    </span>
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

  /** Pill id is what survives serialization — label + kind are looked up at render time. */
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
  // Treat the chip as one indivisible unit — Backspace deletes the whole
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
