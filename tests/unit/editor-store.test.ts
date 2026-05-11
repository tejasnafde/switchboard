/**
 * Editor store backs the multi-buffer / tab-strip surface for the file
 * editor pane. The Buffer object holds a CodeMirror EditorState so
 * switching tabs is `view.setState(buffer.state)` — O(1), preserves
 * cursor + scroll + undo for free.
 *
 * Tested behaviors:
 *   - openBuffer creates a Buffer for a path; second call for same path
 *     returns the existing one (idempotent — clicking the file tree
 *     twice doesn't fork buffers)
 *   - per-session tab list / active tab tracking
 *   - markDirty / clearDirty / closeBuffer
 *   - close-with-dirty needs an explicit force flag
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from '../../src/renderer/stores/editor-store'

beforeEach(() => {
  useEditorStore.setState({ buffers: {}, tabsBySession: {}, activeBySession: {} })
})

describe('useEditorStore — openBuffer', () => {
  it('creates a buffer keyed by path with the supplied content + mtime', () => {
    const id = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/repo/foo.ts', content: 'hello', mtimeMs: 1000,
    })
    const buf = useEditorStore.getState().buffers[id]
    expect(buf.path).toBe('/repo/foo.ts')
    expect(buf.dirty).toBe(false)
    expect(buf.savedDoc).toBe('hello')
    expect(buf.mtimeMs).toBe(1000)
  })

  it('is idempotent — re-opening the same path returns the existing buffer id', () => {
    const a = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/repo/foo.ts', content: 'v1', mtimeMs: 1,
    })
    const b = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/repo/foo.ts', content: 'v2-ignored', mtimeMs: 2,
    })
    expect(b).toBe(a)
    expect(useEditorStore.getState().buffers[a].savedDoc).toBe('v1')
  })

  it('appends the buffer to the per-session tab list and sets it active', () => {
    const id = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/repo/foo.ts', content: '', mtimeMs: 1,
    })
    expect(useEditorStore.getState().tabsBySession['s1']).toEqual([id])
    expect(useEditorStore.getState().activeBySession['s1']).toBe(id)
  })

  it('keeps tab lists isolated per session', () => {
    const a = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/repo/foo.ts', content: '', mtimeMs: 1,
    })
    const b = useEditorStore.getState().openBuffer({
      sessionId: 's2', path: '/repo/bar.ts', content: '', mtimeMs: 1,
    })
    expect(useEditorStore.getState().tabsBySession['s1']).toEqual([a])
    expect(useEditorStore.getState().tabsBySession['s2']).toEqual([b])
  })
})

describe('useEditorStore — markDirty / closeBuffer', () => {
  it('markDirty flips the dirty flag on the buffer', () => {
    const id = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/r/a.ts', content: '', mtimeMs: 1,
    })
    useEditorStore.getState().markDirty(id, true)
    expect(useEditorStore.getState().buffers[id].dirty).toBe(true)
    useEditorStore.getState().markDirty(id, false)
    expect(useEditorStore.getState().buffers[id].dirty).toBe(false)
  })

  it('closeBuffer removes the buffer + its tab + clears active if it was active', () => {
    const id = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/r/a.ts', content: '', mtimeMs: 1,
    })
    const closed = useEditorStore.getState().closeBuffer(id)
    expect(closed).toBe(true)
    expect(useEditorStore.getState().buffers[id]).toBeUndefined()
    expect(useEditorStore.getState().tabsBySession['s1']).toEqual([])
    expect(useEditorStore.getState().activeBySession['s1']).toBeNull()
  })

  it('closing a non-active tab promotes the next tab as active when the active was closed', () => {
    const a = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/r/a.ts', content: '', mtimeMs: 1,
    })
    const b = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/r/b.ts', content: '', mtimeMs: 1,
    })
    // b is currently active (last opened); closing b should fall back to a
    useEditorStore.getState().closeBuffer(b)
    expect(useEditorStore.getState().activeBySession['s1']).toBe(a)
  })

  it('closeBuffer on a dirty buffer refuses without force=true', () => {
    const id = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/r/a.ts', content: '', mtimeMs: 1,
    })
    useEditorStore.getState().markDirty(id, true)
    expect(useEditorStore.getState().closeBuffer(id)).toBe(false)
    expect(useEditorStore.getState().buffers[id]).toBeDefined()
    expect(useEditorStore.getState().closeBuffer(id, { force: true })).toBe(true)
    expect(useEditorStore.getState().buffers[id]).toBeUndefined()
  })
})

describe('useEditorStore — focusBuffer', () => {
  it('sets activeBySession to the focused buffer id', () => {
    const a = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/r/a.ts', content: '', mtimeMs: 1,
    })
    const b = useEditorStore.getState().openBuffer({
      sessionId: 's1', path: '/r/b.ts', content: '', mtimeMs: 1,
    })
    useEditorStore.getState().focusBuffer(a)
    expect(useEditorStore.getState().activeBySession['s1']).toBe(a)
    useEditorStore.getState().focusBuffer(b)
    expect(useEditorStore.getState().activeBySession['s1']).toBe(b)
  })
})
