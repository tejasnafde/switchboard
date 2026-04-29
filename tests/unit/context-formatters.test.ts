/**
 * Multi-source context-bridge formatters. The terminal flow already has
 * `formatTerminalContext` (see context-bridge.test.ts); this file locks
 * down the two new sources:
 *
 *   - file-viewer: a selection in FileViewerPane → `@<path>:<start>-<end>`
 *     pill marker followed by a fenced code block of the lines, both
 *     appended to the active draft.
 *
 *   - chat-message: a selection inside an assistant message bubble →
 *     `> from <agent>: "<text>"` quoted block, so the user can call out a
 *     specific paragraph for follow-up annotation.
 *
 * Both formatters are pure (inputs fully determine outputs) so the wire
 * format stays stable under refactor.
 */
import { describe, it, expect } from 'vitest'
import {
  formatFileViewerContext,
  formatChatMessageContext,
} from '../../src/renderer/services/contextFormatters'

describe('formatFileViewerContext', () => {
  it('emits pill marker + fenced block', () => {
    const out = formatFileViewerContext({
      path: 'src/main/index.ts',
      startLine: 42,
      endLine: 45,
      content: 'const x = 1\nconst y = 2',
    })
    expect(out).toContain('@src/main/index.ts:42-45')
    expect(out).toContain('```')
    expect(out).toContain('const x = 1')
    expect(out).toContain('const y = 2')
  })

  it('uses :line for single-line selections', () => {
    const out = formatFileViewerContext({
      path: 'a/b.py',
      startLine: 3,
      endLine: 3,
      content: 'pass',
    })
    expect(out).toContain('@a/b.py:3')
    expect(out).not.toContain('@a/b.py:3-3')
  })

  it('omits the marker line if path is empty (defensive)', () => {
    const out = formatFileViewerContext({
      path: '',
      startLine: 1,
      endLine: 1,
      content: 'x',
    })
    expect(out).not.toContain('@:')
    expect(out).toContain('x')
  })
})

describe('formatChatMessageContext', () => {
  it('emits "> from <agent>: <text>" with the selection', () => {
    const out = formatChatMessageContext({
      agent: 'Claude',
      selection: 'this paragraph',
    })
    expect(out).toContain('> from Claude:')
    expect(out).toContain('this paragraph')
  })

  it('quotes multi-line selections with > prefix per line', () => {
    const out = formatChatMessageContext({
      agent: 'Codex',
      selection: 'line one\nline two',
    })
    // Each line should be quoted so the agent reads it as one block.
    expect(out).toMatch(/^> .*line one/m)
    expect(out).toMatch(/^> .*line two/m)
  })

  it('falls back to "agent" when name is empty', () => {
    const out = formatChatMessageContext({ agent: '', selection: 'x' })
    expect(out).toContain('> from agent:')
  })
})
