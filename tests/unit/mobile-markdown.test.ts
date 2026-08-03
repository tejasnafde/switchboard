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

describe('tables', () => {
  const t = (md: string) => parseMarkdown(md).find((b) => b.kind === 'table') as
    | Extract<ReturnType<typeof parseMarkdown>[number], { kind: 'table' }>
    | undefined

  it('parses a header, a delimiter row and body rows', () => {
    const table = t('| source | finding |\n|---|---|\n| A | best |\n| B | usable |')
    expect(table).toBeDefined()
    expect(table!.header).toHaveLength(2)
    expect(table!.rows).toHaveLength(2)
  })

  it('reads column alignment from the delimiter row', () => {
    expect(t('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')!.align).toEqual(['left', 'center', 'right'])
  })

  it('leaves alignment null where the delimiter says nothing', () => {
    expect(t('| a |\n|---|\n| 1 |')!.align).toEqual([null])
  })

  it('accepts rows without leading and trailing pipes, which GFM allows', () => {
    const table = t('a | b\n--- | ---\n1 | 2')
    expect(table).toBeDefined()
    expect(table!.header).toHaveLength(2)
    expect(table!.rows[0]).toHaveLength(2)
  })

  it('does not treat an escaped pipe as a cell separator', () => {
    const table = t('| a | b |\n|---|---|\n| x \\| y | z |')
    expect(table!.rows[0]).toHaveLength(2)
  })

  it('ends the table at a blank line rather than swallowing what follows', () => {
    const blocks = parseMarkdown('| a |\n|---|\n| 1 |\n\nAfter the table.')
    expect(blocks.filter((b) => b.kind === 'table')).toHaveLength(1)
    expect(blocks.some((b) => b.kind === 'paragraph')).toBe(true)
  })

  it('still parses a horizontal rule, which the delimiter row resembles', () => {
    // `|---|---|` matches a rule too; the table check runs first.
    expect(parseMarkdown('text\n\n---\n\nmore').some((b) => b.kind === 'rule')).toBe(true)
  })

  it('parses inline markup inside cells', () => {
    const table = t('| a |\n|---|\n| **bold** |')
    expect(table!.rows[0][0][0].kind).toBe('strong')
  })
})

describe('table false positives', () => {
  const kinds = (md: string) => parseMarkdown(md).map((b) => b.kind)

  it('does not turn a bare rule under a piped line into a table', () => {
    // `grep foo | wc -l` in prose split the code span in half.
    const blocks = parseMarkdown('Run `grep foo | wc -l` first.\n---\nNext.')
    expect(blocks.some((b) => b.kind === 'table')).toBe(false)
    expect(blocks.some((b) => b.kind === 'rule')).toBe(true)
  })

  it('keeps a heading, quote and list item that contain a pipe', () => {
    expect(kinds('# Title | Sub\n---')).toContain('heading')
    expect(kinds('> quote | here\n---')).toContain('quote')
    expect(kinds('- item | one\n- - -')).toContain('listItem')
  })

  it('requires the delimiter row to have the header cell count', () => {
    expect(kinds('| a | b |\n|---|\n| 1 | 2 |')).not.toContain('table')
  })

  it('stops the body at a list item that contains a pipe', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n- bullet | pipe\n- plain')
    const table = blocks.find((b) => b.kind === 'table')
    expect(table && table.kind === 'table' && table.rows).toHaveLength(1)
    expect(blocks.filter((b) => b.kind === 'listItem')).toHaveLength(2)
  })

  it('still parses a table with no edge pipes', () => {
    expect(kinds('a | b\n--- | ---\n1 | 2')).toContain('table')
  })
})
