import { describe, expect, it } from 'vitest'
import { marked, type Tokens } from 'marked'
import {
  cellText,
  tableClipboardPayload,
  tableToCsv,
  tableToHtml,
  tableToMarkdown,
  tableToTsv,
  type CopyTableSource,
} from '../../src/renderer/components/chat/table-copy'
import {
  findTableControl,
  renderMarkdownDocument,
  restoreTableControlFocus,
  tableCopyWrite,
} from '../../src/renderer/components/chat/MarkdownWithCopyControls'

function source(markdown: string): CopyTableSource {
  const token = marked.lexer(markdown).find((t) => t.type === 'table') as Tokens.Table
  return { header: token.header, rows: token.rows, align: token.align }
}

// The table from the user's screenshot.
const bigQuery = source(
  [
    '| Check | Match rate |',
    '| --- | --- |',
    "| `roster_adherence_pct` = % of staff with `roster_adherence = 'Compliant'` | 39,426 / 39,459 (99.9%) |",
    "| `roster_compliant` = count of staff with `roster_adherence = 'Compliant'` | 38,236 / 39,459 (97%) |",
  ].join('\n'),
)

describe('table copy serializations', () => {
  it('copies the screenshot table as a clean HTML table and TSV in one payload', () => {
    const { html, text } = tableClipboardPayload(bigQuery)
    expect(html).toBe(
      '<table><thead><tr><th>Check</th><th>Match rate</th></tr></thead><tbody>' +
        "<tr><td><code>roster_adherence_pct</code> = % of staff with <code>roster_adherence = 'Compliant'</code></td><td>39,426 / 39,459 (99.9%)</td></tr>" +
        "<tr><td><code>roster_compliant</code> = count of staff with <code>roster_adherence = 'Compliant'</code></td><td>38,236 / 39,459 (97%)</td></tr>" +
        '</tbody></table>',
    )
    expect(text).toBe(
      [
        'Check\tMatch rate',
        "roster_adherence_pct = % of staff with roster_adherence = 'Compliant'\t39,426 / 39,459 (99.9%)",
        "roster_compliant = count of staff with roster_adherence = 'Compliant'\t38,236 / 39,459 (97%)",
      ].join('\n'),
    )
  })

  it('keeps bold, italics and code in HTML, drops links, and strips markers from text', () => {
    const table = source('| a | b |\n| --- | --- |\n| **Open** and *new* | [docs](https://x.dev) ~~old~~ `x` |')
    expect(tableToHtml(table)).toContain(
      '<td><strong>Open</strong> and <em>new</em></td><td>docs old <code>x</code></td>',
    )
    expect(tableToTsv(table).split('\n')[1]).toBe('Open and new\tdocs old x')
  })

  it('escapes HTML and never emits classes, styles or raw tags', () => {
    const table = source('| a |\n| --- |\n| <b onclick="x()">hi</b> & `<i>` |')
    const html = tableToHtml(table)
    expect(html).toContain('&lt;b onclick=&quot;x()&quot;&gt;hi&lt;/b&gt; &amp; <code>&lt;i&gt;</code>')
    expect(html).not.toMatch(/class=|style=|<b |<i>/)
    expect(cellText(table.rows[0][0])).toBe('<b onclick="x()">hi</b> & <i>')
  })

  it('decodes entities the author wrote before text leaves the app', () => {
    expect(cellText(source('| a |\n| --- |\n| AT&amp;T &#8364;5 |').rows[0][0])).toBe('AT&T €5')
  })

  it('keeps escaped pipes as cell content in every format', () => {
    const table = source('| expr | note |\n| --- | --- |\n| `a \\| b` | x \\| y |')
    expect(tableToTsv(table).split('\n')[1]).toBe('a | b\tx | y')
    expect(tableToMarkdown(table).split('\n')[2]).toBe('| `a \\| b` | x \\| y |')
    expect(tableToHtml(table)).toContain('<td><code>a | b</code></td><td>x | y</td>')
  })

  it('replaces tabs and line breaks inside cells with spaces', () => {
    const table: CopyTableSource = {
      header: [{ text: 'h', tokens: [{ type: 'text', raw: 'h', text: 'h' }], header: true, align: null }],
      rows: [
        [
          {
            text: 'a\tb<br>c',
            tokens: [
              { type: 'text', raw: 'a\tb', text: 'a\tb' },
              { type: 'br', raw: '<br>' },
              { type: 'text', raw: 'c\nd', text: 'c\nd' },
            ],
            header: false,
            align: null,
          },
        ],
      ],
      align: [null],
    }
    expect(tableToTsv(table)).toBe('h\na b c d')
    expect(tableToCsv(table)).toBe('h\r\na b c d')
  })

  it('fills empty and missing cells so every row has the header width', () => {
    const table = source('| a | b | c |\n| --- | --- | --- |\n| 1 |  |\n|  | 2 | 3 |')
    expect(tableToTsv(table)).toBe('a\tb\tc\n1\t\t\n\t2\t3')
    expect(tableToCsv(table)).toBe('a,b,c\r\n1,,\r\n,2,3')
    expect(tableToMarkdown(table).split('\n')[2]).toBe('| 1 |  |  |')
    expect(tableToHtml(table)).toContain('<tr><td>1</td><td></td><td></td></tr>')
  })

  it('quotes CSV fields per RFC 4180', () => {
    const table = source('| name | quote |\n| --- | --- |\n| Smith, J | she said "hi" |\n| plain | 1,204 |')
    expect(tableToCsv(table)).toBe('name,quote\r\n"Smith, J","she said ""hi"""\r\nplain,"1,204"')
  })

  it('neutralizes CSV cells a spreadsheet would run as formulas, and leaves numbers alone', () => {
    const table = source(
      [
        '| cell |',
        '| --- |',
        '| =HYPERLINK("http://x","y") |',
        '| +cmd |',
        '| -rm |',
        '| @SUM(A1) |',
        '| -3.5 |',
        '| +2 |',
        '| 1,204 |',
        '| -42% |',
        '| - |',
        '| a=b |',
      ].join('\n'),
    )
    expect(tableToCsv(table).split('\r\n').slice(1)).toEqual([
      '"\'=HYPERLINK(""http://x"",""y"")"',
      "'+cmd",
      "'-rm",
      "'@SUM(A1)",
      '-3.5',
      '+2',
      '"1,204"',
      '-42%',
      "'-",
      'a=b',
    ])
    expect(tableToTsv(table).split('\n')[1]).toBe('=HYPERLINK("http://x","y")')
    expect(tableToHtml(table)).toContain('<td>+cmd</td>')
  })

  it('neutralizes a leading tab or carriage return in CSV', () => {
    const table: CopyTableSource = {
      header: [{ text: 'h', tokens: [{ type: 'codespan', raw: '`\t=1`', text: '\t=1' }], header: true, align: null }],
      rows: [],
      align: [null],
    }
    // cellText flattens and trims whitespace, so the formula character is what leads.
    expect(tableToCsv(table)).toBe("'=1")
  })

  it('writes a normalized markdown table that keeps the alignment row', () => {
    const table = source('|a|b|c|d|\n|:--|:-:|--:|---|\n|**1**|`2`|3|x|')
    expect(tableToMarkdown(table)).toBe('| a | b | c | d |\n| :--- | :---: | ---: | --- |\n| **1** | `2` | 3 | x |')
  })

  it('omits tbody for a header-only table', () => {
    expect(tableToHtml(source('| a |\n| --- |'))).toBe('<table><thead><tr><th>a</th></tr></thead></table>')
  })
})

describe('table copy controls in rendered markdown', () => {
  const table = '| State | Count |\n| --- | --- |\n| Open | 18 |'

  it('renders a copy button and a format menu button per table, outside the scroll box', () => {
    const { html, tables } = renderMarkdownDocument(`${table}\n\ntext\n\n${table}`)
    expect(tables).toHaveLength(2)
    expect(html).toContain('<div class="markdown-table" data-table-state="settled"><div class="table-copy-controls">')
    expect(html).toContain('aria-label="Copy table 2" aria-live="polite" data-table-copy-index="1">Copy</button>')
    expect(html).toContain('aria-haspopup="dialog" aria-expanded="false" data-table-menu-index="1"')
    expect(html).toMatch(/<\/div><div class="markdown-table-scroll"><table>/)
  })

  it('copies the author alignment, not the numeric right-alignment the renderer adds', () => {
    const { html, tables } = renderMarkdownDocument(table)
    expect(html).toContain('<th align="right">Count</th>')
    expect(tableCopyWrite(tables[0], 'markdown').text).toBe('| State | Count |\n| --- | --- |\n| Open | 18 |')
  })

  it('picks the clipboard formats per menu choice', () => {
    const { tables } = renderMarkdownDocument(table)
    expect(tableCopyWrite(tables[0], 'table')).toEqual({
      html: expect.stringContaining('<table>'),
      text: 'State\tCount\nOpen\t18',
    })
    expect(tableCopyWrite(tables[0], 'csv')).toEqual({ text: 'State,Count\r\nOpen,18' })
    expect(tableCopyWrite(tables[0], 'markdown').html).toBeUndefined()
  })

  it('keeps a table the stream may still extend provisional until content follows or the message settles', () => {
    const streaming = `Intro\n\n${table}\n| Merged | 1`
    expect(renderMarkdownDocument(streaming, { mutable: true }).html).toContain('data-table-state="provisional"')
    expect(renderMarkdownDocument(`${streaming} |\n\nDone.`, { mutable: true }).html).toContain(
      'data-table-state="settled"',
    )
    expect(renderMarkdownDocument(streaming).html).toContain('data-table-state="settled"')
    const nested = renderMarkdownDocument(`- item\n\n  ${table.replaceAll('\n', '\n  ')}`, { mutable: true }).html
    expect(nested).toContain('data-table-state="provisional"')
  })

  it('finds which table control was clicked', () => {
    const control = (dataset: Record<string, string>) => ({ closest: () => ({ dataset }) })
    expect(findTableControl(control({ tableCopyIndex: '2' }))).toEqual({ kind: 'copy', index: 2 })
    expect(findTableControl(control({ tableMenuIndex: '0' }))).toEqual({ kind: 'menu', index: 0 })
    expect(findTableControl(control({ tableMenuIndex: 'x' }))).toBeNull()
    expect(findTableControl({ closest: () => null })).toBeNull()
    expect(findTableControl('text')).toBeNull()
  })

  it('restores focus to a settled table control replaced by a streaming commit', () => {
    const focused: unknown[] = []
    const button = { focus: (options?: FocusOptions) => focused.push(options) }
    const body = {}
    const root = {
      querySelector: (selector: string) =>
        selector === '[data-table-state="settled"] [data-table-menu-index="1"]' ? button : null,
      contains: (target: unknown) => target === button,
    }
    expect(restoreTableControlFocus(root, { kind: 'menu', index: 1 }, body, body)).toBe(true)
    expect(restoreTableControlFocus(root, { kind: 'copy', index: 1 }, body, body)).toBe(false)
    expect(restoreTableControlFocus(root, { kind: 'menu', index: 1 }, {}, body)).toBe(false)
    expect(focused).toEqual([{ preventScroll: true }])
  })
})
