/**
 * Right-pane mode (terminal | files) is a single layout-store field that
 * controls what occupies the workspace's right column. ⌘⇧E in App.tsx
 * toggles it. Tests cover:
 *   - default is 'terminal' (matches existing behavior — no surprise after upgrade)
 *   - setRightPaneMode flips state
 *   - toggleRightPaneMode flips between the two values
 *   - hydration parses persisted setting on launch
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayoutStore, hydrateRightPaneMode } from '../../src/renderer/stores/layout-store'

beforeEach(() => {
  // Reset the singleton store between tests.
  useLayoutStore.setState({ rightPaneMode: 'terminal' })
})

describe('layout-store rightPaneMode', () => {
  it('defaults to terminal so upgraded users keep their existing UI', () => {
    expect(useLayoutStore.getState().rightPaneMode).toBe('terminal')
  })

  it('setRightPaneMode flips the value', () => {
    useLayoutStore.getState().setRightPaneMode('files')
    expect(useLayoutStore.getState().rightPaneMode).toBe('files')
    useLayoutStore.getState().setRightPaneMode('terminal')
    expect(useLayoutStore.getState().rightPaneMode).toBe('terminal')
  })

  it('toggleRightPaneMode cycles terminal → files → kanban → terminal', () => {
    useLayoutStore.getState().toggleRightPaneMode()
    expect(useLayoutStore.getState().rightPaneMode).toBe('files')
    useLayoutStore.getState().toggleRightPaneMode()
    expect(useLayoutStore.getState().rightPaneMode).toBe('kanban')
    useLayoutStore.getState().toggleRightPaneMode()
    expect(useLayoutStore.getState().rightPaneMode).toBe('terminal')
  })

  it('hydrateRightPaneMode parses persisted "files" string', async () => {
    // @ts-expect-error – stubbing the global preload bridge
    globalThis.window = {
      api: {
        settings: {
          get: async (k: string) => (k === 'layout.rightPaneMode' ? 'files' : null),
          set: async () => {},
          remove: async () => {},
        },
      },
    }
    await hydrateRightPaneMode()
    expect(useLayoutStore.getState().rightPaneMode).toBe('files')
    // @ts-expect-error – cleanup
    delete globalThis.window
  })
})
