/**
 * AppView (top-level chats ↔ kanban) lives in layout-store. ⌘⇧K toggles.
 * Workspace + project filters narrow the kanban scope. Tests cover the
 * pure store behavior — App.tsx wires the keybinding separately.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayoutStore } from '../../src/renderer/stores/layout-store'

beforeEach(() => {
  useLayoutStore.setState({
    appView: 'chats',
    kanbanWorkspaceFilter: null,
    kanbanProjectFilter: null,
  })
})

describe('layout-store appView', () => {
  it('defaults to chats — first-launch users see the existing UI', () => {
    expect(useLayoutStore.getState().appView).toBe('chats')
  })

  it('toggleAppView flips chats ↔ kanban', () => {
    useLayoutStore.getState().toggleAppView()
    expect(useLayoutStore.getState().appView).toBe('kanban')
    useLayoutStore.getState().toggleAppView()
    expect(useLayoutStore.getState().appView).toBe('chats')
  })

  it('setAppView writes the value directly', () => {
    useLayoutStore.getState().setAppView('kanban')
    expect(useLayoutStore.getState().appView).toBe('kanban')
  })

  it('changing the workspace filter clears the project filter (avoids stale narrowing)', () => {
    const s = useLayoutStore.getState()
    s.setKanbanProjectFilter('/repos/foo')
    expect(useLayoutStore.getState().kanbanProjectFilter).toBe('/repos/foo')
    s.setKanbanWorkspaceFilter('ws-1')
    expect(useLayoutStore.getState().kanbanWorkspaceFilter).toBe('ws-1')
    expect(useLayoutStore.getState().kanbanProjectFilter).toBeNull()
  })

  it('setKanbanProjectFilter accepts null to clear the project narrow', () => {
    useLayoutStore.getState().setKanbanProjectFilter('/repos/foo')
    useLayoutStore.getState().setKanbanProjectFilter(null)
    expect(useLayoutStore.getState().kanbanProjectFilter).toBeNull()
  })
})
