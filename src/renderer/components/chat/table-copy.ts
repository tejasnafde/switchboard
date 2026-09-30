import type { Token, Tokens } from 'marked'

/**
 * Clipboard serializations of a chat markdown table.
 *
 * "Copy table" writes HTML and TSV in one clipboard item, the pair a
 * spreadsheet puts there itself: Sheets and Excel paste cells, Docs, Gmail
 * and Notion paste a table, Slack renders a table (up to 20 columns and 100
 * rows), and a plain-text field gets TSV. Markdown and CSV are single-format
 * alternatives.
 */

export type TableAlign = Tokens.TableCell['align']

export interface CopyTableSource {
  header: Tokens.TableCell[]
  rows: Tokens.TableCell[][]
  /** The author's alignment, before the renderer right-aligns numeric columns. */
  align: TableAlign[]
}

export interface TableClipboardPayload {
  html: string
  text: string
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()] ?? match
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Tabs and line breaks would start a new cell or row in TSV, CSV and markdown. */
function flatten(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ')
}

function inlineText(tokens: Token[] | undefined): string {
  let out = ''
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'codespan':
        out += token.text
        break
      case 'image':
        out += decodeEntities(token.text)
        break
      case 'br':
        out += ' '
        break
      default:
        out += 'tokens' in token && token.tokens ? inlineText(token.tokens) : decodeEntities('text' in token ? token.text : token.raw)
    }
  }
  return out
}

function inlineHtml(tokens: Token[] | undefined): string {
  let out = ''
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        out += `<strong>${inlineHtml(token.tokens)}</strong>`
        break
      case 'em':
        out += `<em>${inlineHtml(token.tokens)}</em>`
        break
      case 'codespan':
        out += `<code>${escapeHtml(flatten(token.text))}</code>`
        break
      default:
        out += 'tokens' in token && token.tokens
          ? inlineHtml(token.tokens)
          : escapeHtml(flatten(inlineText([token])))
    }
  }
  return out
}

/** Cell plain text: markdown markers stripped, whitespace kept on one line. */
export function cellText(cell: Tokens.TableCell | undefined): string {
  return flatten(inlineText(cell?.tokens)).trim()
}

function rowCells(source: CopyTableSource, row: Tokens.TableCell[]): (Tokens.TableCell | undefined)[] {
  return source.header.map((_, col) => row[col])
}

export function tableToHtml(source: CopyTableSource): string {
  const cell = (tag: 'th' | 'td', value: Tokens.TableCell | undefined): string =>
    `<${tag}>${inlineHtml(value?.tokens).trim()}</${tag}>`
  const head = `<thead><tr>${source.header.map((h) => cell('th', h)).join('')}</tr></thead>`
  const body = source.rows.length === 0
    ? ''
    : `<tbody>${source.rows.map((row) => `<tr>${rowCells(source, row).map((c) => cell('td', c)).join('')}</tr>`).join('')}</tbody>`
  return `<table>${head}${body}</table>`
}

export function tableToTsv(source: CopyTableSource): string {
  return [source.header, ...source.rows]
    .map((row) => rowCells(source, row).map(cellText).join('\t'))
    .join('\n')
}

const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/

/**
 * A CSV opened in a spreadsheet runs a cell starting with = + - @ (or a tab
 * or carriage return) as a formula. A leading apostrophe makes it text
 * (OWASP CSV injection); numbers such as -3.5 are left alone.
 */
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) && !NUMBER.test(value) ? `'${value}` : value
}

function csvField(value: string): string {
  const safe = neutralizeFormula(value)
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/**
 * RFC 4180: CRLF between records, a field with a comma or quote is quoted.
 * Only CSV guards formulas: the default copy's HTML pastes into Sheets and
 * Excel as values, and an apostrophe would show in Slack or a text field.
 */
export function tableToCsv(source: CopyTableSource): string {
  return [source.header, ...source.rows]
    .map((row) => rowCells(source, row).map((c) => csvField(cellText(c))).join(','))
    .join('\r\n')
}

function markdownCell(cell: Tokens.TableCell | undefined): string {
  return flatten(cell?.text ?? '').trim().replaceAll('|', '\\|')
}

const ALIGN_MARKER: Record<string, string> = { left: ':---', center: ':---:', right: '---:' }

/** A normalized GFM pipe table: one space of padding, the author's alignment. */
export function tableToMarkdown(source: CopyTableSource): string {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`
  return [
    line(source.header.map(markdownCell)),
    line(source.header.map((_, col) => ALIGN_MARKER[source.align[col] ?? ''] ?? '---')),
    ...source.rows.map((row) => line(rowCells(source, row).map(markdownCell))),
  ].join('\n')
}

export function tableClipboardPayload(source: CopyTableSource): TableClipboardPayload {
  return { html: tableToHtml(source), text: tableToTsv(source) }
}
