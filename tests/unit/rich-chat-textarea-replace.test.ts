/**
 * Pins the shape of `replaceRange` in RichChatTextarea. The recurring
 * bug: calling `setValue(next)` alongside `editor.update(...)` races
 * HydrationPlugin into "restoring" a stale caret of 0 (= the caret
 * before the slash command was inserted). The fix is to do only the
 * Lexical update and let OnChangePlugin propagate the new body. Reads
 * the source and forbids `setValue(...)` inside `replaceRange`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = resolve(__dirname, '../../src/renderer/components/chat/lexical/RichChatTextarea.tsx')

function extractReplaceRangeBody(src: string): string {
  // Skip the interface declaration (typed signature `=> void`); find the
  // impl, which is an untyped arrow with a `{` body.
  const re = /replaceRange:\s*\([^)]*\)\s*=>\s*\{/g
  let m: RegExpExecArray | null
  let start = -1
  while ((m = re.exec(src)) !== null) { start = m.index; break }
  if (start === -1) throw new Error('replaceRange impl not found')
  // Find the matching closing brace of the arrow body. `replaceRange:
  // (start, end, replacement) => { ... }` — brace-count from the first
  // `{` after the arrow.
  const arrow = src.indexOf('=>', start)
  const open = src.indexOf('{', arrow)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('unmatched brace in replaceRange')
}

describe('RichChatTextarea.replaceRange shape', () => {
  const src = readFileSync(SRC, 'utf8')
  const body = extractReplaceRangeBody(src)

  it('does NOT call setValue — that re-render races with editor.update and resets the caret', () => {
    // Allow the substring inside comments (we mention the bug there) but
    // forbid the actual call expression.
    const stripComments = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(stripComments).not.toMatch(/\bsetValue\s*\(/)
  })

  it('calls $populateFromBody inside editor.update', () => {
    expect(body).toMatch(/editor\.update\(/)
    expect(body).toContain('$populateFromBody(')
  })

  it('snaps the caret to after the inserted text via $selectAtOffset', () => {
    expect(body).toContain('$selectAtOffset(start + replacement.length)')
  })
})
