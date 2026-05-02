/**
 * Unit tests for `renderPillBody` — splits a `[[pill:<id>]]`-tokenized
 * body into React nodes (text spans + PillChipVisual chips). Critical
 * because this is what makes a sent user message visually mirror the
 * editor's pill state. We assert on the React element tree directly so
 * the test stays node-only (no testing-library / jsdom).
 */
import { describe, it, expect } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderPillBody, type PillsMeta } from '../../src/renderer/components/chat/renderPillBody'
import { PillChipVisual } from '../../src/renderer/components/chat/lexical/PillChipVisual'

function asElement(n: ReactNode): ReactElement {
  if (!isValidElement(n)) throw new Error('expected ReactElement')
  return n
}

function isChip(n: ReactNode): boolean {
  return isValidElement(n) && (n as ReactElement).type === PillChipVisual
}

function isSpan(n: ReactNode): boolean {
  return isValidElement(n) && (n as ReactElement).type === 'span'
}

function spanText(n: ReactNode): string {
  return (asElement(n).props as { children?: string }).children ?? ''
}

const meta: PillsMeta = {
  abc: { label: 'a.ts', kind: 'file' },
  def: { label: 'pane:1', kind: 'terminal' },
  xyz: { label: 'Claude: …', kind: 'chat-message' },
}

describe('renderPillBody', () => {
  it('returns an empty array for an empty body', () => {
    expect(renderPillBody('', meta)).toEqual([])
  })

  it('returns a single text span for body with no tokens', () => {
    const out = renderPillBody('plain prose', meta)
    expect(out).toHaveLength(1)
    expect(isSpan(out[0])).toBe(true)
    expect(spanText(out[0])).toBe('plain prose')
  })

  it('replaces a known token with a chip', () => {
    const out = renderPillBody('see [[pill:abc]] please', meta)
    expect(out).toHaveLength(3)
    expect(isSpan(out[0])).toBe(true)
    expect(spanText(out[0])).toBe('see ')
    expect(isChip(out[1])).toBe(true)
    expect((asElement(out[1]).props as { label: string; kind: string }).label).toBe('a.ts')
    expect((asElement(out[1]).props as { label: string; kind: string }).kind).toBe('file')
    expect(isSpan(out[2])).toBe(true)
    expect(spanText(out[2])).toBe(' please')
  })

  it('drops tokens with unknown ids and emits no placeholder', () => {
    const out = renderPillBody('hi [[pill:nope]] there', meta)
    // text "hi ", (chip skipped), text " there"
    expect(out).toHaveLength(2)
    expect(spanText(out[0])).toBe('hi ')
    expect(spanText(out[1])).toBe(' there')
  })

  it('renders adjacent tokens without merging or dropping the gap', () => {
    const out = renderPillBody('[[pill:abc]][[pill:def]]', meta)
    expect(out).toHaveLength(2)
    expect(isChip(out[0])).toBe(true)
    expect(isChip(out[1])).toBe(true)
    expect((asElement(out[0]).props as { kind: string }).kind).toBe('file')
    expect((asElement(out[1]).props as { kind: string }).kind).toBe('terminal')
  })

  it('handles a token at the very start and end of the body', () => {
    const out = renderPillBody('[[pill:abc]] middle [[pill:xyz]]', meta)
    expect(out).toHaveLength(3)
    expect(isChip(out[0])).toBe(true)
    expect(isSpan(out[1])).toBe(true)
    expect(spanText(out[1])).toBe(' middle ')
    expect(isChip(out[2])).toBe(true)
  })

  it('treats malformed tokens as plain text', () => {
    // single bracket
    const a = renderPillBody('[pill:abc]', meta)
    expect(a).toHaveLength(1)
    expect(isSpan(a[0])).toBe(true)
    // whitespace in id
    const b = renderPillBody('[[pill:bad id]]', meta)
    expect(b).toHaveLength(1)
    expect(isSpan(b[0])).toBe(true)
    // empty id
    const c = renderPillBody('[[pill:]]', meta)
    expect(c).toHaveLength(1)
    expect(isSpan(c[0])).toBe(true)
  })

  it('all keys are unique (no React duplicate-key warnings)', () => {
    const out = renderPillBody('a [[pill:abc]] b [[pill:def]] c', meta)
    const keys = out.map((n) => (isValidElement(n) ? n.key : null))
    const filtered = keys.filter((k): k is string => typeof k === 'string')
    expect(new Set(filtered).size).toBe(filtered.length)
  })
})
