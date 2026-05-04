/**
 * Pins the `<ResizeHandle>` wiring in App.tsx. The recurring bug: a
 * copy-pasted handle ends up with `beforeRef={sidebarRef}` on the
 * terminal divider, which sticks `pointerEvents:'none'` on the sidebar
 * after an interrupted drag and breaks BOTH panes. Parses the JSX text
 * (no jsdom available) and forbids the exact bad shape.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const APP_TSX = resolve(__dirname, '../../src/renderer/App.tsx')

function extractResizeHandles(src: string): string[] {
  // Match either `<ResizeHandle ... />` (self-closing) or
  // `<ResizeHandle ...>...</ResizeHandle>` (with children) so the parser
  // doesn't silently skip handles if someone adds children later.
  const out: string[] = []
  const re = /<ResizeHandle\b[\s\S]*?(\/>|<\/ResizeHandle>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[0])
  return out
}

describe('App.tsx resize handle wiring', () => {
  const src = readFileSync(APP_TSX, 'utf8')
  const handles = extractResizeHandles(src)

  it('declares exactly two ResizeHandle elements (sidebar + terminal)', () => {
    expect(handles.length).toBe(2)
  })

  it('sidebar handle: beforeRef=sidebarRef, no invert', () => {
    const sidebar = handles.find((h) => h.includes('beforeRef={sidebarRef}'))
    expect(sidebar, 'expected a handle with beforeRef={sidebarRef}').toBeDefined()
    expect(sidebar!).not.toMatch(/\binvert\b/)
    expect(sidebar!).not.toContain('terminalRef')
  })

  it('terminal handle: afterRef=terminalRef + invert, and does NOT reference sidebarRef', () => {
    const terminal = handles.find((h) => h.includes('afterRef={terminalRef}'))
    expect(terminal, 'expected a handle with afterRef={terminalRef}').toBeDefined()
    expect(terminal!).toMatch(/\binvert\b/)
    // The recurring bug: copy-pasting the sidebar handle leaves
    // beforeRef={sidebarRef} on the terminal divider, which causes
    // stale pointerEvents:'none' on the sidebar after an interrupted
    // drag — both panes become un-resizable. Forbid that exact shape.
    expect(terminal!).not.toContain('sidebarRef')
  })
})
