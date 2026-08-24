import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { useLayoutStore } from '../../src/renderer/stores/layout-store'

describe('explicit message file routing', () => {
  const open = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        settings: { set: vi.fn(() => Promise.resolve()) },
        ide: { open },
      },
    })
    open.mockClear()
    useAgentStore.setState({
      activeSessionId: 'left',
      sessions: [
        { id: 'left', projectPath: '/repo/a', machineId: 'local' },
        { id: 'right', projectPath: '/repo/b', worktreePath: '/repo/b-wt', machineId: 'vm-b' },
      ] as ReturnType<typeof useAgentStore.getState>['sessions'],
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('opens a right-panel file against the owning worktree and machine', () => {
    useLayoutStore.getState().openInViewer('src/query.sql', { start: 4, end: 8 }, 'right')

    expect(open).toHaveBeenCalledWith({
      folder: '/repo/b-wt',
      path: 'src/query.sql',
      line: 4,
      endLine: 8,
      machineId: 'vm-b',
    })
  })
})
