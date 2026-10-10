/**
 * Splits a pill-tokenized body string (`text [[pill:id]] more text`) into
 * an ordered React node array - text spans interleaved with chips.
 * Tokens whose ids aren't in `pillsMeta` are dropped (matches the
 * editor's hydration semantics).
 */
import type { ReactNode } from 'react'
import { PillChipVisual } from './lexical/PillChipVisual'
import type { DraftPillKind } from '../../stores/draft-store'
import { pillContentInMessage } from '../../services/pill-chip-model'
import { PILL_LABEL_ATTR } from '../../services/context-formatters'

export type PillsMeta = Record<string, { label: string; kind: DraftPillKind }>

const TOKEN_RE = /\[\[pill:([a-zA-Z0-9_-]+)\]\]/g

/**
 * `messageText` is the text the agent received, where each pill was expanded;
 * a chip that finds its block there gets the composer's count and card.
 */
export function renderPillBody(body: string, pillsMeta: PillsMeta, messageText = ''): ReactNode[] {
  const out: ReactNode[] = []
  if (!body) return out
  // Fresh regex per call - guard against sticky lastIndex if TOKEN_RE were reused.
  const re = new RegExp(TOKEN_RE.source, 'g')
  let cursor = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(body)) !== null) {
    if (m.index > cursor) {
      out.push(<span key={key++}>{body.slice(cursor, m.index)}</span>)
    }
    const meta = pillsMeta[m[1]]
    if (meta) {
      const content = pillContentInMessage(meta.kind, meta.label, messageText)
      out.push(<PillChipVisual key={key++} label={meta.label} kind={meta.kind} content={content} selectable rootProps={{ [PILL_LABEL_ATTR]: meta.label }} />)
    }
    cursor = m.index + m[0].length
  }
  if (cursor < body.length) {
    out.push(<span key={key++}>{body.slice(cursor)}</span>)
  }
  return out
}
