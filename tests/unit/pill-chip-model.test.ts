import { describe, expect, it } from 'vitest'
import { pillChipKind, pillChipModel, pillContentInMessage, splitChipName } from '../../src/renderer/services/pill-chip-model'
import { formatChatMessageContext, formatFileViewerContext } from '../../src/renderer/services/context-formatters'
import { reviewContextLabel, type ReviewContext } from '../../src/shared/review-context'

const terminalContent = '[from: api @ 14:31 · npm run dev]\n```\nError: state token expired\n    at handleCallback\n    at processTicks\nPOST /api/oauth/callback 500\nline five\n```\n'

describe('pillChipKind', () => {
  it('reads the user\'s own message from a chat-message label', () => {
    expect(pillChipKind('chat-message', 'you: "Keep the old cookie"')).toBe('you')
    expect(pillChipKind('chat-message', 'Claude: "The exchange"')).toBe('chat-message')
    expect(pillChipKind('chat-message', 'Youtube: "x"')).toBe('chat-message')
    expect(pillChipKind('file', 'you: "x"')).toBe('file')
  })
})

describe('pillChipModel counts', () => {
  it('terminal: the line count from the label, none for one line', () => {
    expect(pillChipModel({ kind: 'terminal', label: 'api (12 lines)' })).toMatchObject({ name: 'api', count: '12 lines', detail: '12 lines' })
    expect(pillChipModel({ kind: 'terminal', label: 'api (1 line)' })).toMatchObject({ name: 'api', count: null, detail: '1 line' })
  })

  it('file: an en dash range, none for a single line or an @-mention', () => {
    expect(pillChipModel({ kind: 'file', label: 'auth.ts (1-7)' })).toMatchObject({ name: 'auth.ts', count: '1–7', detail: 'lines 1–7' })
    expect(pillChipModel({ kind: 'file', label: 'auth.ts (42)' })).toMatchObject({ name: 'auth.ts', count: null, detail: 'line 42' })
    expect(pillChipModel({ kind: 'file', label: 'auth.ts' })).toMatchObject({ name: 'auth.ts', count: null, detail: null })
  })

  it('message: lines of the quote when the content is known', () => {
    const content = formatChatMessageContext({ agent: 'Claude', selection: 'The exchange should wait.\nRight now it runs first.' })
    expect(pillChipModel({ kind: 'chat-message', label: 'Claude: "The exchange should wait."', content }))
      .toMatchObject({ kind: 'chat-message', name: 'Claude', count: '2 lines', preview: ['The exchange should wait.', 'Right now it runs first.'] })
    expect(pillChipModel({ kind: 'chat-message', label: 'Claude: "x"' })).toMatchObject({ count: null, detail: null })
  })

  it('you: named You, no count for one line', () => {
    const content = formatChatMessageContext({ agent: 'you', selection: 'Keep the old cookie name.' })
    expect(pillChipModel({ kind: 'chat-message', label: 'you: "Keep the old cookie name."', content }))
      .toMatchObject({ kind: 'you', name: 'You', source: 'Your message', count: null, target: { type: 'message', role: 'user', quote: 'Keep the old cookie name.' } })
  })

  it('review: threads, named after the pull request', () => {
    const ctx = {
      pr: { number: 612 },
      items: [
        { kind: 'conversation', path: 'a.ts', line: 3, side: 'new', outdated: false, comments: [], diff: null },
        { kind: 'conversation', path: 'b.ts', line: 9, side: 'new', outdated: false, comments: [], diff: null },
        { kind: 'conversation', path: 'c.ts', line: 1, side: 'new', outdated: false, comments: [], diff: null },
      ],
    } as unknown as ReviewContext
    const label = reviewContextLabel(ctx)
    expect(pillChipModel({ kind: 'review', label })).toMatchObject({ name: 'PR #612', count: '3 threads', detail: '3 threads', target: null })
    expect(pillChipModel({ kind: 'review', label: '1 review conversation · #7 · a.ts:3' })).toMatchObject({ name: 'PR #7', count: null, detail: '1 thread', where: 'a.ts:3' })
    expect(pillChipModel({ kind: 'review', label: '2 failed checks · #7' })).toMatchObject({ count: '2 checks' })
  })
})

describe('pillChipModel preview and target', () => {
  it('terminal: the command, four lines and what is left', () => {
    const model = pillChipModel({ kind: 'terminal', label: 'api (5 lines)', content: terminalContent })
    expect(model.where).toBe('npm run dev')
    expect(model.preview).toEqual(['Error: state token expired', '    at handleCallback', '    at processTicks', 'POST /api/oauth/callback 500'])
    expect(model.moreLines).toBe(1)
    expect(model.target).toEqual({ type: 'terminal', paneLabel: 'api' })
  })

  it('file: the path and lines to open', () => {
    const content = formatFileViewerContext({ path: 'src/api/auth.ts', startLine: 1, endLine: 2, content: 'a\nb\n' })
    const model = pillChipModel({ kind: 'file', label: 'auth.ts (1-2)', content })
    expect(model.where).toBe('src/api/auth.ts')
    expect(model.preview).toEqual(['a', 'b'])
    expect(model.target).toEqual({ type: 'file', path: 'src/api/auth.ts', startLine: 1, endLine: 2 })
    expect(pillChipModel({ kind: 'file', label: 'auth.ts', content: '@src/api/auth.ts' }).target)
      .toEqual({ type: 'file', path: 'src/api/auth.ts', startLine: null, endLine: null })
    expect(pillChipModel({ kind: 'file', label: 'auth.ts (1-2)' }).target).toBeNull()
  })
})

describe('splitChipName', () => {
  it('cuts a long file name in the middle and keeps the extension', () => {
    const { head, tail } = splitChipName('file', 'provider-registry-handoff-preamble.ts')
    expect(tail).toBe('eamble.ts')
    expect(head.endsWith('…')).toBe(true)
    expect(head.length + tail.length).toBeLessThanOrEqual(24)
    expect(`${head}${tail}`).toMatch(/^provider-reg.*…eamble\.ts$/)
  })

  it('keeps a long extension whole', () => {
    const { tail } = splitChipName('file', 'some-very-long-generated-name.component.stories')
    expect(tail.endsWith('.stories')).toBe(true)
  })

  it('leaves short names and other kinds alone', () => {
    expect(splitChipName('file', 'auth.ts')).toEqual({ head: 'auth.ts', tail: '' })
    expect(splitChipName('terminal', 'a-very-long-terminal-pane-label-indeed')).toEqual({ head: 'a-very-long-terminal-pane-label-indeed', tail: '' })
  })
})

describe('pillContentInMessage', () => {
  it('finds a terminal block in the sent text', () => {
    const text = `Why does this fail ${terminalContent} after the retry?`
    expect(pillContentInMessage('terminal', 'api (5 lines)', text)).toBe(terminalContent.trimEnd())
  })

  it('finds a single-line terminal capture', () => {
    const block = '[from: web @ 09:02]\nready in 38ms'
    expect(pillContentInMessage('terminal', 'web (1 line)', `see ${block}\n and more`)).toBe(block)
  })

  it('finds a file selection and an @-mention', () => {
    const block = formatFileViewerContext({ path: 'src/api/auth.ts', startLine: 1, endLine: 2, content: 'a\nb' })
    expect(pillContentInMessage('file', 'auth.ts (1-2)', `Compare ${block} with it`)).toBe(block.trimEnd())
    expect(pillContentInMessage('file', 'auth.ts', 'Compare @src/api/auth.ts with it')).toBe('@src/api/auth.ts')
    expect(pillContentInMessage('file', 'auth.ts', 'Compare @src/api/oauth.ts with it')).toBeNull()
  })

  it('finds a quoted message by its label preview', () => {
    const block = formatChatMessageContext({ agent: 'Claude', selection: 'The exchange should wait.\nRight now it runs first.' })
    const found = pillContentInMessage('chat-message', 'Claude: "The exchange should wait."', `Look: ${block}and fix it`)
    expect(found).toBe(block.trimEnd())
    expect(pillChipModel({ kind: 'chat-message', label: 'Claude: "x"', content: found }).count).toBe('2 lines')
  })

  it('returns null when the block is not there', () => {
    expect(pillContentInMessage('terminal', 'api (3 lines)', 'nothing here')).toBeNull()
    expect(pillContentInMessage('review', '3 review conversations · #612', 'anything')).toBeNull()
  })
})
