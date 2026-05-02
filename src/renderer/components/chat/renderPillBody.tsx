/**
 * Splits a pill-tokenized body string (`text [[pill:id]] more text`) into
 * an ordered React node array — text spans interleaved with chips.
 * Tokens whose ids aren't in `pillsMeta` are dropped (matches the
 * editor's hydration semantics).
 */
import type { ReactNode } from 'react'
import { PillChipVisual } from './lexical/PillChipVisual'
import type { DraftPillKind } from '../../stores/draft-store'

export type PillsMeta = Record<string, { label: string; kind: DraftPillKind }>

const TOKEN_RE = /\[\[pill:([a-zA-Z0-9_-]+)\]\]/g

export function renderPillBody(body: string, pillsMeta: PillsMeta): ReactNode[] {
  const out: ReactNode[] = []
  if (!body) return out
  // Fresh regex per call — guard against sticky lastIndex if TOKEN_RE were reused.
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
      out.push(<PillChipVisual key={key++} label={meta.label} kind={meta.kind} selectable />)
    }
    cursor = m.index + m[0].length
  }
  if (cursor < body.length) {
    out.push(<span key={key++}>{body.slice(cursor)}</span>)
  }
  return out
}
