import { describe, expect, it } from 'vitest'
import { resolveBubbleProjectPath } from '../../src/renderer/components/chat/MessageBubble'

describe('resolveBubbleProjectPath', () => {
  const sessions = [
    { id: 'left', projectPath: '/repo/left' },
    { id: 'right', projectPath: '/repo/right' },
  ]

  it('prefers the bubble session over the globally active session', () => {
    expect(resolveBubbleProjectPath(sessions, 'right', 'left')).toBe('/repo/right')
  })

  it('falls back to the active session for legacy single-panel callers', () => {
    expect(resolveBubbleProjectPath(sessions, undefined, 'left')).toBe('/repo/left')
  })
})
