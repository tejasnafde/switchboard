import {
  Component,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from 'react'
import { marked, Renderer, type Token, type Tokens } from 'marked'
import { createRendererLogger } from '../../logger'
import { tableClipboardPayload, tableToCsv, tableToMarkdown, type CopyTableSource } from './table-copy'
import { TableCopyMenu, type TableCopyFormat } from './TableCopyMenu'

const log = createRendererLogger('chat:markdown-copy')

interface RenderMarkdownOptions {
  mutable?: boolean
}

interface MarkdownWithCopyControlsProps extends RenderMarkdownOptions {
  markdown: string
  className?: string
  style?: CSSProperties
}

interface ClosestTarget {
  closest: (selector: string) => unknown
}

interface CopyButtonTarget extends ClosestTarget {
  dataset?: { codeCopyIndex?: string }
}

interface CodeContainer {
  querySelector: (selector: string) => { textContent?: string | null } | null
}

interface FeedbackButtonTarget {
  textContent: string | null
  classList: { toggle: (name: string, force: boolean) => void }
  setAttribute: (name: string, value: string) => void
}

interface FocusRoot<T> {
  querySelector: (selector: string) => { focus: (options?: FocusOptions) => void } | null
  contains: (target: T) => boolean
}

export const COPY_FEEDBACK_MS = 1500

function findCopyButton(target: unknown): CopyButtonTarget | null {
  if (!target || typeof (target as Partial<ClosestTarget>).closest !== 'function') return null
  return ((target as ClosestTarget).closest('.code-copy-btn') as CopyButtonTarget | null) ?? null
}

export async function copyCodeFromTarget(
  target: unknown,
  writeText: (text: string) => Promise<void>,
  onError?: (error: unknown) => void,
): Promise<number | null> {
  const button = findCopyButton(target)
  const index = Number(button?.dataset?.codeCopyIndex)
  const pre = button?.closest('pre') as CodeContainer | null | undefined
  const code = pre?.querySelector('code')
  if (!button || !Number.isInteger(index) || !code) return null

  try {
    await writeText(code.textContent ?? '')
    return index
  } catch (error) {
    onError?.(error)
    return null
  }
}

export function focusedCopyIndexBeforeReplacement<T>(
  root: Pick<FocusRoot<T>, 'contains'>,
  activeElement: T,
): number | null {
  if (!root.contains(activeElement)) return null
  const button = findCopyButton(activeElement)
  const index = Number(button?.dataset?.codeCopyIndex)
  return button && Number.isInteger(index) ? index : null
}

export function scheduleCopyFeedback<T>(
  index: number,
  setCopiedIndex: (index: number | null) => void,
  schedule: (callback: () => void, delayMs: number) => T,
  cancel: (timer: T) => void,
): () => void {
  setCopiedIndex(index)
  const timer = schedule(() => setCopiedIndex(null), COPY_FEEDBACK_MS)
  return () => cancel(timer)
}

export function applyCopyButtonFeedback(
  button: FeedbackButtonTarget,
  index: number,
  copied: boolean,
): void {
  button.textContent = copied ? 'Copied' : 'Copy'
  button.classList.toggle('copied', copied)
  button.setAttribute('aria-label', `${copied ? 'Copied' : 'Copy'} code block ${index + 1}`)
}

export function restoreCopyButtonFocus<T>(
  root: FocusRoot<T>,
  index: number | null,
  activeElement: T,
  bodyElement: T,
): boolean {
  if (index === null || (activeElement !== bodyElement && !root.contains(activeElement))) return false
  const button = root.querySelector(
    `[data-code-state="settled"] [data-code-copy-index="${index}"]`,
  )
  if (!button) return false
  button.focus({ preventScroll: true })
  return true
}

export interface TableControlTarget {
  kind: 'copy' | 'menu'
  index: number
}

interface TableControlElement extends ClosestTarget {
  dataset?: { tableCopyIndex?: string; tableMenuIndex?: string }
}

export function findTableControl(target: unknown): TableControlTarget | null {
  if (!target || typeof (target as Partial<ClosestTarget>).closest !== 'function') return null
  const control = (target as ClosestTarget).closest('.table-copy-btn, .table-copy-menu-btn') as TableControlElement | null
  if (!control) return null
  const copy = control.dataset?.tableCopyIndex
  const raw = copy ?? control.dataset?.tableMenuIndex
  const index = Number(raw)
  if (raw === undefined || !Number.isInteger(index)) return null
  return { kind: copy !== undefined ? 'copy' : 'menu', index }
}

function tableControlSelector({ kind, index }: TableControlTarget): string {
  return kind === 'copy' ? `[data-table-copy-index="${index}"]` : `[data-table-menu-index="${index}"]`
}

/** Same rule as restoreCopyButtonFocus, for a table's two buttons. */
export function restoreTableControlFocus<T>(
  root: FocusRoot<T>,
  control: TableControlTarget | null,
  activeElement: T,
  bodyElement: T,
): boolean {
  if (control === null || (activeElement !== bodyElement && !root.contains(activeElement))) return false
  const button = root.querySelector(`[data-table-state="settled"] ${tableControlSelector(control)}`)
  if (!button) return false
  button.focus({ preventScroll: true })
  return true
}

export function applyTableCopyFeedback(
  button: FeedbackButtonTarget,
  index: number,
  copied: boolean,
): void {
  button.textContent = copied ? 'Copied' : 'Copy'
  button.classList.toggle('copied', copied)
  button.setAttribute('aria-label', `${copied ? 'Copied' : 'Copy'} table ${index + 1}`)
}

export function tableCopyWrite(
  source: CopyTableSource,
  format: TableCopyFormat,
): { html?: string; text: string } {
  if (format === 'markdown') return { text: tableToMarkdown(source) }
  if (format === 'csv') return { text: tableToCsv(source) }
  return tableClipboardPayload(source)
}

export function wrapRenderedCodeBlock(
  defaultCodeBlock: string,
  state: 'provisional' | 'settled',
  index: number,
): string {
  const code = /^<pre>([\s\S]*)<\/pre>\n?$/.exec(defaultCodeBlock)?.[1]
  if (code === undefined) return defaultCodeBlock
  const button = `<button class="code-copy-btn" type="button" aria-label="Copy code block ${index + 1}" aria-live="polite" data-code-copy-index="${index}">Copy</button>`
  return `<pre class="markdown-code-block" data-code-state="${state}">${code}${button}</pre>\n`
}

function hasClosingFence(raw: string): boolean {
  const lines = raw.replace(/\n$/, '').split('\n')
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0])?.[1]
  if (!opening) return false
  return lines.slice(1).some((line) => {
    const closing = /^ {0,3}([`~]+)[ \t]*$/.exec(line)?.[1]
    return !!closing &&
      closing.length >= opening.length &&
      [...closing].every((char) => char === opening[0])
  })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function isSafeMarkdownDestination(href: string): boolean {
  const compact = href.trim().replace(/[\u0000-\u0020\u007f]/g, '')
  const firstDelimiter = compact.search(/[/:?#]/)
  const schemePrefix = firstDelimiter < 0 ? compact : compact.slice(0, firstDelimiter)
  // An entity before the first URL delimiter can be decoded by the browser
  // into a hidden scheme character (for example jav&#x61;script:).
  if (/&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i.test(schemePrefix)) return false
  const scheme = /^([a-z][\da-z+.-]*):/i.exec(compact)?.[1]?.toLowerCase()
  return !scheme || scheme === 'http' || scheme === 'https' || scheme === 'mailto'
}

/** A cell that reads as a number: "18", "1,204", "-3.5", "42%", "**18**". */
const NUMERIC_CELL = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/

/**
 * Right-aligns a table column whose body cells are all numbers, unless the
 * author chose an alignment. Empty cells and a dash do not count against it.
 */
export function alignNumericColumns(token: Tokens.Table): void {
  token.align.forEach((align, col) => {
    if (align !== null) return
    const cells = token.rows.map((row) => row[col]?.text.replace(/[*_`]/g, '').trim() ?? '').filter((t) => t !== '' && t !== '-')
    if (cells.length === 0 || !cells.every((t) => NUMERIC_CELL.test(t))) return
    // The renderer reads each cell's own align, not the table's.
    token.align[col] = 'right'
    if (token.header[col]) token.header[col].align = 'right'
    for (const row of token.rows) if (row[col]) row[col].align = 'right'
  })
}

export interface RenderedMarkdown {
  html: string
  /** Copy sources for each rendered table, indexed by data-table-copy-index. */
  tables: CopyTableSource[]
}

export function wrapRenderedTable(
  defaultTable: string,
  state: 'provisional' | 'settled',
  index: number,
): string {
  const n = index + 1
  const controls = '<div class="table-copy-controls">' +
    `<button class="table-copy-btn" type="button" aria-label="Copy table ${n}" aria-live="polite" data-table-copy-index="${index}">Copy</button>` +
    `<button class="table-copy-menu-btn" type="button" aria-label="More ways to copy table ${n}" aria-haspopup="dialog" aria-expanded="false" data-table-menu-index="${index}">▾</button>` +
    '</div>'
  // A wide table scrolls inside its own box instead of stretching the bubble;
  // the controls sit outside that box so they stay put while it scrolls.
  return `<div class="markdown-table" data-table-state="${state}">${controls}<div class="markdown-table-scroll">${defaultTable}</div></div>\n`
}

/**
 * A table has no closing marker, so while a message streams the one it ends
 * with may still grow rows. Tables inside the last block stay provisional
 * until more content follows or the message settles.
 */
function trailingTables(tokens: Token[]): Set<Token> {
  let last: Token | undefined
  for (let i = tokens.length - 1; i >= 0 && !last; i--) {
    if (tokens[i].type !== 'space') last = tokens[i]
  }
  const tables = new Set<Token>()
  if (last) {
    marked.walkTokens([last], (token) => {
      if (token.type === 'table') tables.add(token)
    })
  }
  return tables
}

export function renderMarkdownDocument(
  markdown: string,
  { mutable = false }: RenderMarkdownOptions = {},
): RenderedMarkdown {
  const renderer = new Renderer()
  const renderCode = renderer.code.bind(renderer)
  const renderLink = renderer.link.bind(renderer)
  const renderImage = renderer.image.bind(renderer)
  const renderTable = renderer.table.bind(renderer)
  const tokens = marked.lexer(markdown)
  const provisionalTables = mutable ? trailingTables(tokens) : new Set<Token>()
  const authorAlign = new WeakMap<Token, Tokens.Table['align']>()
  const tables: CopyTableSource[] = []
  let blockIndex = 0

  marked.walkTokens(tokens, (token) => {
    if (token.type !== 'table') return
    authorAlign.set(token, [...(token as Tokens.Table).align])
    alignNumericColumns(token as Tokens.Table)
  })

  renderer.table = (token: Tokens.Table) => {
    const index = tables.length
    tables.push({ header: token.header, rows: token.rows, align: authorAlign.get(token) ?? token.align })
    return wrapRenderedTable(renderTable(token), provisionalTables.has(token) ? 'provisional' : 'settled', index)
  }

  renderer.code = (token: Tokens.Code) => {
    const index = blockIndex++
    const state = !mutable || hasClosingFence(token.raw) ? 'settled' : 'provisional'
    return wrapRenderedCodeBlock(renderCode(token), state, index)
  }

  renderer.html = (token: Tokens.HTML | Tokens.Tag) => escapeHtml(token.text)
  renderer.link = (token: Tokens.Link) => {
    if (!isSafeMarkdownDestination(token.href)) return renderer.parser.parseInline(token.tokens)
    const rendered = renderLink(token)
    return rendered.replace(
      /^<a href="[^"]*"/,
      `<a href="${escapeHtml(token.href)}"`,
    )
  }
  renderer.image = (token: Tokens.Image) => {
    if (!isSafeMarkdownDestination(token.href)) return escapeHtml(token.text)
    const rendered = renderImage(token)
    return rendered.replace(
      /^<img src="[^"]*"/,
      `<img src="${escapeHtml(token.href)}"`,
    )
  }

  return { html: marked.parser(tokens, { async: false, renderer }), tables }
}

export function renderMarkdownWithCopyControls(
  markdown: string,
  options: RenderMarkdownOptions = {},
): string {
  return renderMarkdownDocument(markdown, options).html
}

interface AtomicMarkdownRootProps {
  html: string
  className: string
  style?: CSSProperties
  rootRef: RefObject<HTMLDivElement | null>
  onClick: (event: MouseEvent<HTMLDivElement>) => void
}

interface FocusedControlSnapshot {
  code: number | null
  table: TableControlTarget | null
}

class AtomicMarkdownRoot extends Component<AtomicMarkdownRootProps> {
  // React 19 rewrites innerHTML whenever this object's identity changes, so a
  // new one per render replaced every node (and dropped focus) on any parent
  // re-render. Keep one per html string.
  private innerHtml = { __html: this.props.html }

  getSnapshotBeforeUpdate(previousProps: AtomicMarkdownRootProps): FocusedControlSnapshot | null {
    if (previousProps.html === this.props.html) return null
    const root = this.props.rootRef.current
    if (!root || !root.contains(document.activeElement)) return null
    return {
      code: focusedCopyIndexBeforeReplacement(root, document.activeElement),
      table: findTableControl(document.activeElement),
    }
  }

  componentDidUpdate(
    _previousProps: AtomicMarkdownRootProps,
    _previousState: unknown,
    focused: FocusedControlSnapshot | null,
  ): void {
    const root = this.props.rootRef.current
    if (!root || !focused) return
    if (focused.code !== null) {
      restoreCopyButtonFocus(root, focused.code, document.activeElement, document.body)
    } else if (focused.table !== null) {
      restoreTableControlFocus(root, focused.table, document.activeElement, document.body)
    }
  }

  render() {
    if (this.innerHtml.__html !== this.props.html) this.innerHtml = { __html: this.props.html }
    return (
      <div
        ref={this.props.rootRef}
        className={this.props.className}
        style={this.props.style}
        onClick={this.props.onClick}
        dangerouslySetInnerHTML={this.innerHtml}
      />
    )
  }
}

export const MarkdownWithCopyControls = forwardRef<HTMLDivElement, MarkdownWithCopyControlsProps>(
  function MarkdownWithCopyControls(
    { markdown, mutable = false, className = 'markdown-content', style },
    ref,
  ) {
    const [copiedBlockIndex, setCopiedBlockIndex] = useState<number | null>(null)
    const [copiedTableIndex, setCopiedTableIndex] = useState<number | null>(null)
    // The table whose menu is (or was last) open: kept after closing so the
    // menu can still find its button to return focus to.
    const [menuTableIndex, setMenuTableIndex] = useState<number | null>(null)
    const [menuOpen, setMenuOpen] = useState(false)
    const cancelTableFeedbackRef = useRef<(() => void) | null>(null)
    const previousTableFeedbackIndexRef = useRef<number | null>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const cancelFeedbackRef = useRef<(() => void) | null>(null)
    const previousFeedbackIndexRef = useRef<number | null>(null)
    const mountedRef = useRef(false)
    const { html: rendered, tables } = useMemo(
      () => renderMarkdownDocument(markdown, { mutable }),
      [markdown, mutable],
    )
    const tablesRef = useRef(tables)
    tablesRef.current = tables

    useImperativeHandle(ref, () => rootRef.current as HTMLDivElement)

    useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
        cancelFeedbackRef.current?.()
        cancelTableFeedbackRef.current?.()
      }
    }, [])

    useLayoutEffect(() => {
      const root = rootRef.current
      if (!root) return
      const indices = new Set([previousFeedbackIndexRef.current, copiedBlockIndex])
      for (const index of indices) {
        if (index === null) continue
        const button = root.querySelector<HTMLButtonElement>(`[data-code-copy-index="${index}"]`)
        if (button) applyCopyButtonFeedback(button, index, index === copiedBlockIndex)
      }
      previousFeedbackIndexRef.current = copiedBlockIndex
    }, [copiedBlockIndex, rendered])

    useLayoutEffect(() => {
      const root = rootRef.current
      if (!root) return
      const indices = new Set([previousTableFeedbackIndexRef.current, copiedTableIndex])
      for (const index of indices) {
        if (index === null) continue
        const button = root.querySelector<HTMLButtonElement>(`[data-table-copy-index="${index}"]`)
        if (button) applyTableCopyFeedback(button, index, index === copiedTableIndex)
      }
      previousTableFeedbackIndexRef.current = copiedTableIndex
      if (menuOpen && menuTableIndex !== null) {
        root.querySelector(`[data-table-menu-index="${menuTableIndex}"]`)?.setAttribute('aria-expanded', 'true')
      }
    }, [copiedTableIndex, menuOpen, menuTableIndex, rendered])

    const copyTable = useCallback((index: number, format: TableCopyFormat) => {
      const source = tablesRef.current[index]
      if (!source) return
      const { html, text } = tableCopyWrite(source, format)
      const write = (): Promise<void> => {
        if (!html) {
          if (typeof navigator.clipboard?.writeText !== 'function') {
            return Promise.reject(new Error('Clipboard API unavailable'))
          }
          return navigator.clipboard.writeText(text)
        }
        if (typeof navigator.clipboard?.write !== 'function' || typeof ClipboardItem !== 'function') {
          return Promise.reject(new Error('Clipboard API unavailable'))
        }
        // One item with both formats, as a spreadsheet copies: rich targets
        // take the HTML table, plain-text fields take the TSV.
        return navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })])
      }
      void write().then(() => {
        if (!mountedRef.current) return
        cancelTableFeedbackRef.current?.()
        cancelTableFeedbackRef.current = scheduleCopyFeedback(
          index,
          setCopiedTableIndex,
          (callback, delayMs) => window.setTimeout(callback, delayMs),
          (timer) => window.clearTimeout(timer),
        )
      }, (error: unknown) => {
        log.warn('table clipboard write failed', { format, error })
      })
    }, [])

    const findMenuAnchor = useCallback(
      () => menuTableIndex === null
        ? null
        : rootRef.current?.querySelector<HTMLElement>(`[data-table-menu-index="${menuTableIndex}"]`) ?? null,
      [menuTableIndex],
    )

    const closeMenu = useCallback(() => {
      rootRef.current
        ?.querySelector(`[data-table-menu-index="${menuTableIndex}"]`)
        ?.setAttribute('aria-expanded', 'false')
      setMenuOpen(false)
    }, [menuTableIndex])

    const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
      const tableControl = findTableControl(event.target)
      if (tableControl) {
        event.preventDefault()
        event.stopPropagation()
        const settled = (event.target as Element).closest('[data-table-state="settled"]')
        if (!settled) return
        if (tableControl.kind === 'copy') copyTable(tableControl.index, 'table')
        else if (menuOpen && menuTableIndex === tableControl.index) closeMenu()
        else {
          setMenuTableIndex(tableControl.index)
          setMenuOpen(true)
        }
        return
      }
      if (!findCopyButton(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      const writeText = (text: string): Promise<void> => {
        if (typeof navigator.clipboard?.writeText !== 'function') {
          return Promise.reject(new Error('Clipboard API unavailable'))
        }
        return navigator.clipboard.writeText(text)
      }
      void copyCodeFromTarget(event.target, writeText, (error) => {
        log.warn('clipboard write failed', error)
      }).then((index) => {
        if (index === null || !mountedRef.current) return
        cancelFeedbackRef.current?.()
        cancelFeedbackRef.current = scheduleCopyFeedback(
          index,
          setCopiedBlockIndex,
          (callback, delayMs) => window.setTimeout(callback, delayMs),
          (timer) => window.clearTimeout(timer),
        )
      })
    }, [closeMenu, copyTable, menuOpen, menuTableIndex])

    return <>
      <AtomicMarkdownRoot
        html={rendered}
        className={className}
        style={style}
        rootRef={rootRef}
        onClick={handleClick}
      />
      {tables.length > 0 && (
        <TableCopyMenu
          open={menuOpen}
          findAnchor={findMenuAnchor}
          onClose={closeMenu}
          onCopy={(format) => {
            if (menuTableIndex !== null) copyTable(menuTableIndex, format)
            closeMenu()
          }}
        />
      )}
    </>
  },
)
