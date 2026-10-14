// @vitest-environment jsdom
/**
 * The chip viewer shows the exact text a chip expanded to: numbered monospace
 * lines for a terminal (error lines tinted) and a file (its own line numbers),
 * wrapped text for a message. Copy and Cmd+C copy all of it. "Go to source"
 * appears only when the source resolves; otherwise, or once an open does not
 * land, a quiet note says this is the text that was sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const open = vi.hoisted(() => ({
  action: 'Open pane' as string | null,
  result: true,
  openPillTarget: vi.fn(async () => open.result),
}))
vi.mock('../../src/renderer/services/pill-chip-open', () => ({
  openPillTarget: open.openPillTarget,
  pillSourceAction: () => open.action,
}))

import { PillChipViewer } from '../../src/renderer/components/chat/lexical/PillChipViewer'
import { pillChipModel, type PillChipModel } from '../../src/renderer/services/pill-chip-model'
import { formatFileViewerContext } from '../../src/renderer/services/context-formatters'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let onOpenChange: ReturnType<typeof vi.fn>
const writeText = vi.fn(async (_text: string) => {})

beforeEach(() => {
  open.action = 'Open pane'
  open.result = true
  open.openPillTarget.mockClear()
  writeText.mockClear()
  onOpenChange = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const terminal = pillChipModel({
  kind: 'terminal',
  label: 'api (3 lines)',
  content: '[from: api @ 14:31 · npm run dev]\n```\nready\nError: state token expired\n    at verify\n```\n',
})

function render(model: PillChipModel, sent = true): void {
  act(() =>
    root.render(
      createElement(PillChipViewer, {
        model,
        icon: null,
        tintStyle: {},
        sessionId: 's1',
        sent,
        open: true,
        onOpenChange,
      }),
    ),
  )
}

const dialog = () => document.querySelector<HTMLElement>('[data-pill-viewer]')
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === name)
const note = () => document.querySelector('[data-pill-viewer-note]')

describe('PillChipViewer', () => {
  it('shows a terminal capture as numbered lines with the errors tinted', () => {
    render(terminal)
    expect(dialog()?.getAttribute('data-pill-viewer')).toBe('terminal')
    expect(dialog()?.textContent).toContain('npm run dev')
    const rows = [...document.querySelectorAll('[data-pill-viewer-body] pre > div')]
    expect(rows.map((row) => row.textContent)).toEqual(['1ready', '2Error: state token expired', '3    at verify'])
    expect(document.querySelectorAll('[data-error-line]')).toHaveLength(1)
  })

  it("numbers a file range from the file's own lines", () => {
    const content = formatFileViewerContext({ path: 'src/a.ts', startLine: 40, endLine: 41, content: 'x\ny\n' })
    render(pillChipModel({ kind: 'file', label: 'a.ts (40-41)', content }))
    const gutters = [...document.querySelectorAll('[data-pill-viewer-body] pre i')].map((i) => i.textContent)
    expect(gutters).toEqual(['40', '41'])
  })

  it('wraps a message with no line numbers', () => {
    const content = '> from Claude: "The exchange should wait."\n> Swap them.'
    render(pillChipModel({ kind: 'chat-message', label: 'Claude: "The exchange should wait."', content }))
    const body = document.querySelector('[data-pill-viewer-body]')!
    expect(body.querySelector('pre')).toBeNull()
    expect(body.textContent).toBe('The exchange should wait.\nSwap them.')
  })

  it('copies the whole capture with Copy and with Cmd+C when nothing is selected', async () => {
    render(terminal)
    await act(async () => button('Copy')!.click())
    expect(writeText).toHaveBeenLastCalledWith('ready\nError: state token expired\n    at verify')
    expect(button('Copied')).toBeDefined()
    writeText.mockClear()
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('offers Go to source when it resolves, and closes once it lands', async () => {
    render(terminal)
    expect(note()).toBeNull()
    await act(async () => button('Open pane')!.click())
    expect(open.openPillTarget).toHaveBeenCalledWith(terminal.target, 's1')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('drops Go to source for the note when the open does not land', async () => {
    open.result = false
    render(terminal)
    await act(async () => button('Open pane')!.click())
    expect(button('Open pane')).toBeUndefined()
    expect(note()?.textContent).toBe('The pane has closed. This is the output that was sent.')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('shows the note and no Go to source when the source does not resolve', () => {
    open.action = null
    render(pillChipModel({ kind: 'chat-message', label: 'Claude: "x"', content: '> from Claude: "x"' }))
    expect(button('Show in chat')).toBeUndefined()
    expect(note()?.textContent).toBe('This is the text that was sent with your message.')
  })

  it('says the composer text will be sent', () => {
    open.action = null
    render(terminal, false)
    expect(note()?.textContent).toBe('This is the text that will be sent with your message.')
  })

  it('shows only Open in Reviews for a review chip with no text', () => {
    open.action = 'Open in Reviews'
    render(pillChipModel({ kind: 'review', label: '2 failed checks · #7' }))
    expect(button('Open in Reviews')).toBeDefined()
    expect(button('Copy')).toBeUndefined()
    expect(document.querySelector('[data-pill-viewer-body]')).toBeNull()
  })
})
