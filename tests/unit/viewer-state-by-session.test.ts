import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Per-session viewer state map: switching sessions should restore the
 * file last opened in that chat. Tested at the reducer level so we
 * don't need React/zustand wired up.
 */

interface ViewerState {
  viewerFilePath: string | null
  viewerLineRange: { start: number; end: number } | null
  viewerStateBySession: Record<string, { path: string; lineRange: { start: number; end: number } | null }>
}

function emptyState(): ViewerState {
  return { viewerFilePath: null, viewerLineRange: null, viewerStateBySession: {} }
}

function openInViewer(state: ViewerState, sessionId: string | null, path: string, lineRange: { start: number; end: number } | null = null): ViewerState {
  const map = { ...state.viewerStateBySession }
  if (sessionId) map[sessionId] = { path, lineRange }
  return { viewerFilePath: path, viewerLineRange: lineRange, viewerStateBySession: map }
}

function hydrateForSession(state: ViewerState, sessionId: string | null): ViewerState {
  if (!sessionId) return { ...state, viewerFilePath: null, viewerLineRange: null }
  const remembered = state.viewerStateBySession[sessionId]
  if (!remembered) return { ...state, viewerFilePath: null, viewerLineRange: null }
  return { ...state, viewerFilePath: remembered.path, viewerLineRange: remembered.lineRange }
}

describe('viewer state per session', () => {
  let s: ViewerState
  beforeEach(() => { s = emptyState() })

  it('records path keyed by active session', () => {
    s = openInViewer(s, 'A', 'src/foo.ts')
    expect(s.viewerStateBySession.A).toEqual({ path: 'src/foo.ts', lineRange: null })
    expect(s.viewerFilePath).toBe('src/foo.ts')
  })

  it('records line range alongside path', () => {
    s = openInViewer(s, 'A', 'src/foo.ts', { start: 10, end: 20 })
    expect(s.viewerStateBySession.A?.lineRange).toEqual({ start: 10, end: 20 })
  })

  it('switching sessions restores the per-session path', () => {
    s = openInViewer(s, 'A', 'a.ts')
    s = openInViewer(s, 'B', 'b.ts')
    s = hydrateForSession(s, 'A')
    expect(s.viewerFilePath).toBe('a.ts')
    s = hydrateForSession(s, 'B')
    expect(s.viewerFilePath).toBe('b.ts')
  })

  it('hydrating an unknown session clears the viewer', () => {
    s = openInViewer(s, 'A', 'a.ts')
    s = hydrateForSession(s, 'C')
    expect(s.viewerFilePath).toBeNull()
    expect(s.viewerLineRange).toBeNull()
    // But A's record is preserved
    expect(s.viewerStateBySession.A?.path).toBe('a.ts')
  })

  it('null sessionId during open does not write a record', () => {
    s = openInViewer(s, null, 'orphan.ts')
    expect(Object.keys(s.viewerStateBySession)).toHaveLength(0)
    expect(s.viewerFilePath).toBe('orphan.ts')
  })

  it('reopening the same file replaces the prior line range', () => {
    s = openInViewer(s, 'A', 'a.ts', { start: 1, end: 5 })
    s = openInViewer(s, 'A', 'a.ts', null)
    expect(s.viewerStateBySession.A?.lineRange).toBeNull()
  })
})

describe('fuzzyScore', () => {
  it('matches consecutive characters higher than scattered ones', async () => {
    const { fuzzyScore } = await import('../../src/renderer/components/files/fuzzyScore')
    const a = fuzzyScore('foo', 'foo.ts')
    const b = fuzzyScore('foo', 'fXoXo.ts')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!).toBeGreaterThan(b!)
  })
  it('returns null for non-matches', async () => {
    const { fuzzyScore } = await import('../../src/renderer/components/files/fuzzyScore')
    expect(fuzzyScore('zzz', 'foo.ts')).toBeNull()
  })
  it('boosts basename matches', async () => {
    const { fuzzyScore } = await import('../../src/renderer/components/files/fuzzyScore')
    const inBase = fuzzyScore('app', 'src/app.tsx')
    const inDir = fuzzyScore('app', 'app/foo/bar.tsx')
    expect(inBase).not.toBeNull()
    expect(inDir).not.toBeNull()
    expect(inBase!).toBeGreaterThan(inDir!)
  })
})

vi.fn()
