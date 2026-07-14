import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { showDragOverlay, hideDragOverlay, isDragOverlayActive } from '../../src/renderer/services/dragOverlay'

/**
 * The drag overlay is the shield that keeps the pointer inside the host
 * document during a pane resize (so capture isn't lost to the IDE webview /
 * xterm and the drag can always end). The test env is `node` with no DOM, so
 * we inject a tiny fake `document` - the module reads `document` lazily inside
 * its functions, so this is enough to exercise the create/idempotent/cleanup
 * logic that prevents a stuck overlay.
 */

class FakeEl {
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  private container: FakeEl[] | null = null
  attachTo(children: FakeEl[]) { this.container = children; children.push(this) }
  remove() {
    if (!this.container) return
    const i = this.container.indexOf(this)
    if (i >= 0) this.container.splice(i, 1)
    this.container = null
  }
}

const body = {
  children: [] as FakeEl[],
  appendChild(el: FakeEl) { el.attachTo(this.children) },
}

const fakeDoc = { createElement: () => new FakeEl(), body }

describe('dragOverlay', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { document: unknown }).document = fakeDoc
    body.children = []
    hideDragOverlay() // reset module singleton between tests
  })
  afterEach(() => {
    hideDragOverlay()
  })

  it('creates exactly one overlay element with the given cursor', () => {
    showDragOverlay('col-resize')
    expect(isDragOverlayActive()).toBe(true)
    expect(body.children.length).toBe(1)
    expect(body.children[0].style.cursor).toBe('col-resize')
    expect(body.children[0].style.position).toBe('fixed')
    expect(body.children[0].dataset.dragOverlay).toBe('')
  })

  it('is idempotent: a second show reuses the element and just updates cursor', () => {
    showDragOverlay('col-resize')
    showDragOverlay('row-resize')
    expect(body.children.length).toBe(1)
    expect(body.children[0].style.cursor).toBe('row-resize')
  })

  it('hide removes the element and clears active state', () => {
    showDragOverlay('col-resize')
    hideDragOverlay()
    expect(isDragOverlayActive()).toBe(false)
    expect(body.children.length).toBe(0)
  })

  it('hide is safe to call when no overlay is active (no throw, no negative state)', () => {
    expect(() => hideDragOverlay()).not.toThrow()
    expect(isDragOverlayActive()).toBe(false)
    expect(body.children.length).toBe(0)
  })

  it('show → hide → show cycles cleanly without leaking elements', () => {
    showDragOverlay('col-resize')
    hideDragOverlay()
    showDragOverlay('row-resize')
    expect(body.children.length).toBe(1)
    expect(isDragOverlayActive()).toBe(true)
  })
})
