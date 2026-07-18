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

  it('terminal handle: afterRef targets the fixed-width pane (mode-aware) + invert, and does NOT reference sidebarRef', () => {
    // Data scientist mode swaps which pane is fixed-width, so the handle
    // targets dsChatRef there and terminalRef otherwise.
    const terminal = handles.find((h) => h.includes('afterRef={dataScienceMode ? dsChatRef : terminalRef}'))
    expect(terminal, 'expected a handle with the mode-aware afterRef').toBeDefined()
    expect(terminal!).toMatch(/\binvert\b/)
    // The recurring bug: copy-pasting the sidebar handle leaves
    // beforeRef={sidebarRef} on the terminal divider, which causes
    // stale pointerEvents:'none' on the sidebar after an interrupted
    // drag - both panes become un-resizable. Forbid that exact shape.
    expect(terminal!).not.toContain('sidebarRef')
  })

  // ⌘B / ⌘J → toggle off → toggle on used to break both resize handles
  // because the store imperatively mutated `el.style.width/visibility`
  // while the JSX carried a constant width string. React's reconciler
  // skipped the unchanged-string write on toggle-on and DOM drifted
  // from state. Drive width AND visibility from JSX instead.
  it('sidebar div: width + visibility are visibility-aware in JSX', () => {
    expect(src).toMatch(/sidebarVisible \? `\$\{sidebarWidth\}px` : '0px'/)
    expect(src).toMatch(/visibility: sidebarVisible \? 'visible' : 'hidden'/)
  })

  it('terminal div: width + visibility are visibility-aware in JSX', () => {
    expect(src).toMatch(/terminalVisible \? `\$\{terminalWidth\}px` : '0px'/)
    expect(src).toMatch(/visibility: terminalVisible \? 'visible' : 'hidden'/)
  })

  // Pins the actual root cause: the listener-attaching useEffect must
  // re-run on visibility change. The component returns null when hidden
  // WITHOUT unmounting (the parent still renders <ResizeHandle />), so
  // empty-deps `[]` would leave listeners stuck on a detached node and
  // the freshly-rendered div on re-show would have no listeners - both
  // handles silently break after a toggle-off → toggle-on cycle.
  it('ResizeHandle: listener effect depends on `visible` so it re-runs on toggle', () => {
    const HANDLE = resolve(__dirname, '../../src/renderer/components/layout/ResizeHandle.tsx')
    const handleSrc = readFileSync(HANDLE, 'utf8')
    // The big effect ends with `}, [visible])`. Forbid the empty-deps shape
    // anywhere in the file as an extra guardrail.
    expect(handleSrc).toMatch(/}, \[visible\]\)/)
    expect(handleSrc).not.toMatch(/}, \[\]\)/)
  })

  it('layout-store: toggleSidebar/toggleTerminal do NOT call applyPanelVisibility', () => {
    const STORE = resolve(__dirname, '../../src/renderer/stores/layout-store.ts')
    const storeSrc = readFileSync(STORE, 'utf8')
    expect(storeSrc).not.toMatch(/^\s*function applyPanelVisibility\b/m)
    expect(storeSrc).not.toMatch(/applyPanelVisibility\(/)
  })

  // The user asked to lift the max width caps (⌘B / ⌘J hide panes entirely,
  // so a hard cap adds no safety). The old fixed caps were 500 / 800.
  it('main-pane handles no longer carry a fixed max cap', () => {
    for (const h of handles) {
      expect(h).not.toMatch(/max=\{\s*\d+\s*\}/) // no numeric literal max
    }
    const sidebar = handles.find((h) => h.includes('beforeRef={sidebarRef}'))!
    const terminal = handles.find((h) => h.includes('afterRef={dataScienceMode ? dsChatRef : terminalRef}'))!
    expect(sidebar).toContain('max={sidebarMax}')
    expect(terminal).toContain('max={terminalMax}')
  })

  it('layout-store: no fixed SIDEBAR_MAX / TERMINAL_MAX constants remain', () => {
    const STORE = resolve(__dirname, '../../src/renderer/stores/layout-store.ts')
    const storeSrc = readFileSync(STORE, 'utf8')
    expect(storeSrc).not.toMatch(/SIDEBAR_MAX/)
    expect(storeSrc).not.toMatch(/TERMINAL_MAX/)
    expect(storeSrc).toMatch(/export function paneMaxWidth/)
  })
})

// Guards against the "boundary stuck in resize mode" regression: dragging a
// divider and releasing over the IDE webview / xterm canvas left the drag
// never ending. Every handle must (a) recover via `lostpointercapture` and
// (b) raise the full-viewport drag overlay so the pointer can't reach a
// child frame in the first place.
describe('resize handles: stuck-drag hardening', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8')

  it('ResizeHandle listens for lostpointercapture and uses the drag overlay', () => {
    const src = read('../../src/renderer/components/layout/ResizeHandle.tsx')
    expect(src).toContain("addEventListener('lostpointercapture'")
    expect(src).toContain('showDragOverlay(')
    expect(src).toContain('hideDragOverlay(')
  })

  it('PaneResizeHandle listens for lostpointercapture and uses the drag overlay', () => {
    const src = read('../../src/renderer/components/terminal/PaneResizeHandle.tsx')
    expect(src).toContain("addEventListener('lostpointercapture'")
    expect(src).toContain('showDragOverlay(')
    expect(src).toContain('hideDragOverlay(')
  })

  it('ChatSplitHandle handles pointercancel + lostpointercapture + overlay', () => {
    const src = read('../../src/renderer/App.tsx')
    expect(src).toContain('onPointerCancel={() => endDrag()}')
    expect(src).toContain('onLostPointerCapture={() => endDrag()}')
    // and a window blur fallback for the dual-chat divider
    expect(src).toMatch(/const onBlur = \(\) => endDrag\(\)/)
  })
})
