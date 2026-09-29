import { describe, expect, it } from 'vitest'
import { renderMarkdownWithCopyControls } from '../../src/renderer/components/chat/MarkdownWithCopyControls'

const table = [
  'Your bot-v2 PRs since 15 Sep:',
  '',
  '| State | Count |',
  '| --- | --- |',
  '| **Open** | **18** |',
  '| Merged | 17 |',
  '| Declined | 0 |',
].join('\n')

describe('chat markdown tables', () => {
  it('wraps a table in its own scroll box', () => {
    expect(renderMarkdownWithCopyControls(table)).toMatch(/<div class="markdown-table"><table>/)
  })

  it('right-aligns a column of numbers, bold ones included, and leaves text columns alone', () => {
    const html = renderMarkdownWithCopyControls(table)
    expect(html).toContain('<th align="right">Count</th>')
    expect(html).toContain('<td align="right"><strong>18</strong></td>')
    expect(html).toContain('<td align="right">0</td>')
    expect(html).toMatch(/<th>State<\/th>/)
  })

  it("keeps the author's alignment and does not call a mixed column numeric", () => {
    const html = renderMarkdownWithCopyControls('| a | b |\n| :---: | --- |\n| 1 | 2 |\n| 3 | n/a |')
    expect(html).toContain('<th align="center">a</th>')
    expect(html).toMatch(/<th>b<\/th>/)
  })

  it('counts thousands, decimals, percents and signs as numbers, and skips empty cells', () => {
    const html = renderMarkdownWithCopyControls('| n |\n| --- |\n| 1,204 |\n| -3.5 |\n| 42% |\n|  |\n| - |')
    expect(html).toContain('<th align="right">n</th>')
  })
})
