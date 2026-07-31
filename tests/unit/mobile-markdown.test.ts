/**
 * Markdown parsing for the mobile chat feed. Agent replies are Markdown and were
 * being rendered raw, so `**bold**` and fenced code showed their own syntax.
 */
import { describe, it, expect } from 'vitest'
import { parseMarkdown, parseInline, inlinesToText } from '../../apps/mobile/src/lib/markdown'

describe('parseInline', () => {
  it('reads bold, italic, strike and code', () => {
    expect(parseInline('a **b** c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' c' },
    ])
    expect(parseInline('*i*')[0]).toMatchObject({ kind: 'em' })
    expect(parseInline('~~gone~~')[0]).toMatchObject({ kind: 'strike' })
    expect(parseInline('`code`')[0]).toEqual({ kind: 'code', text: 'code' })
  })

  it('treats a code span as literal, so markers inside it are not emphasis', () => {
    // Constant in agent output: `npm i -D **` must not start a bold run.
    const nodes = parseInline('run `npm i -D **` now')
    expect(nodes).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'npm i -D **' },
      { kind: 'text', text: ' now' },
    ])
  })

  it('does not treat snake_case as emphasis', () => {
    expect(inlinesToText(parseInline('some_long_name here'))).toBe('some_long_name here')
    expect(parseInline('some_long_name here').every((n) => n.kind === 'text')).toBe(true)
  })

  it('parses links and bare URLs', () => {
    expect(parseInline('[docs](https://x.dev/a)')[0]).toMatchObject({
      kind: 'link',
      href: 'https://x.dev/a',
      children: [{ kind: 'text', text: 'docs' }],
    })
    expect(parseInline('see https://x.dev/a')[1]).toMatchObject({ kind: 'link', href: 'https://x.dev/a' })
  })

  it('nests emphasis inside emphasis', () => {
    const [node] = parseInline('**bold with `code`**')
    expect(node).toMatchObject({ kind: 'strong' })
    expect(inlinesToText([node])).toBe('bold with code')
  })

  it('leaves an unmatched marker as text instead of dropping it', () => {
    expect(inlinesToText(parseInline('2 * 3 * 4'))).toBe('2 * 3 * 4')
    expect(inlinesToText(parseInline('**unclosed'))).toBe('**unclosed')
  })
})

describe('parseMarkdown blocks', () => {
  it('extracts a fenced code block with its language', () => {
    const blocks = parseMarkdown('before\n\n```ts\nconst a = 1\nconst b = 2\n```\n\nafter')
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'code', 'paragraph'])
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'ts', text: 'const a = 1\nconst b = 2' })
  })

  it('keeps an unterminated fence as code, which is how it looks mid-stream', () => {
    const blocks = parseMarkdown('```py\nx = 1')
    expect(blocks).toEqual([{ kind: 'code', lang: 'py', text: 'x = 1' }])
  })

  it('does not treat markdown inside a fence as markdown', () => {
    const blocks = parseMarkdown('```\n# not a heading\n- not a list\n```')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'code', text: '# not a heading\n- not a list' })
  })

  it('reads headings with their level', () => {
    const blocks = parseMarkdown('# One\n### Three')
    expect(blocks).toMatchObject([
      { kind: 'heading', level: 1 },
      { kind: 'heading', level: 3 },
    ])
  })

  it('reads bullet and ordered lists, including nesting depth', () => {
    const blocks = parseMarkdown('- a\n  - b\n1. first\n2. second')
    expect(blocks).toMatchObject([
      { kind: 'listItem', ordered: false, depth: 0 },
      { kind: 'listItem', ordered: false, depth: 1 },
      { kind: 'listItem', ordered: true, marker: '1.', depth: 0 },
      { kind: 'listItem', ordered: true, marker: '2.', depth: 0 },
    ])
  })

  it('folds consecutive quote lines into one block', () => {
    const blocks = parseMarkdown('> line one\n> line two')
    expect(blocks).toHaveLength(1)
    expect(inlinesToText((blocks[0] as { inlines: never[] }).inlines)).toBe('line one\nline two')
  })

  it('reads horizontal rules but not a bullet item', () => {
    expect(parseMarkdown('---')).toEqual([{ kind: 'rule' }])
    expect(parseMarkdown('- item')[0].kind).toBe('listItem')
  })

  it('joins wrapped lines into one paragraph and splits on a blank line', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree')
    expect(blocks).toHaveLength(2)
    expect(inlinesToText((blocks[0] as { inlines: never[] }).inlines)).toBe('one\ntwo')
  })

  it('returns nothing for empty or whitespace input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n  \n')).toEqual([])
  })

  it('terminates on adversarial marker soup', () => {
    const blocks = parseMarkdown('*'.repeat(400) + '\n' + '`'.repeat(200) + '\n> ' + '_'.repeat(200))
    expect(blocks.length).toBeGreaterThan(0)
  })
})
