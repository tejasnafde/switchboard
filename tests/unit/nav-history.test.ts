/**
 * Navigation-history wiring across layout-store + editor-store (D6/D7).
 *
 *   D6: a single jump must push exactly ONE history entry. `navigateTo`
 *       previously pushed once itself AND again via openInViewer.
 *   D7: replaying a back/forward target must NOT push a new entry (which
 *       would truncate the forward stack and break forward navigation).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useLayoutStore } from '../../src/renderer/stores/layout-store'
import { useEditorStore } from '../../src/renderer/stores/editor-store'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { navigateTo, recordLocation } from '../../src/renderer/components/files/editor/navigation/navigate'

beforeEach(() => {
  useEditorStore.setState({ navBySession: {} })
  useAgentStore.setState({ activeSessionId: 's1' })
})

function nav(sessionId: string) {
  return useEditorStore.getState().navBySession[sessionId]
}

describe('openInViewer history (D6/D7)', () => {
  it('pushes exactly one entry per openInViewer', () => {
    useLayoutStore.getState().openInViewer('a.ts', { start: 1, end: 1 })
    useLayoutStore.getState().openInViewer('b.ts', { start: 2, end: 2 })
    expect(nav('s1').entries.map((e) => e.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('navigateTo pushes only one entry (no double-push)', () => {
    navigateTo('s1', { path: 'a.ts', line: 5 })
    expect(nav('s1').entries).toHaveLength(1)
  })

  it('replaying a target with recordHistory:false preserves the forward stack (D7)', () => {
    useLayoutStore.getState().openInViewer('a.ts', { start: 1, end: 1 })
    useLayoutStore.getState().openInViewer('b.ts', { start: 2, end: 2 })

    // Step back to a.ts and replay it WITHOUT recording history.
    const back = useEditorStore.getState().navBack('s1')
    expect(back?.path).toBe('a.ts')
    useLayoutStore.getState().openInViewer('a.ts', { start: 1, end: 1 }, { recordHistory: false })

    // Forward must still be available and land on b.ts.
    expect(useEditorStore.getState().canNavForward('s1')).toBe(true)
    expect(useEditorStore.getState().navForward('s1')?.path).toBe('b.ts')
  })

  it('recordLocation makes back return to the exact invocation spot (Bug B)', () => {
    // Opened a.ts (recorded at line 1), then scrolled/clicked to line 40 and
    // jumped to a definition in b.ts. Back must return to a.ts:40 - not the
    // stale a.ts:1 entry, and not some earlier file.
    useLayoutStore.getState().openInViewer('a.ts', { start: 1, end: 1 })
    recordLocation('s1', 'a.ts', 40)
    useLayoutStore.getState().openInViewer('b.ts', { start: 5, end: 5 })
    expect(useEditorStore.getState().navBack('s1')).toEqual({ path: 'a.ts', line: 40, ch: 0 })
  })
})
