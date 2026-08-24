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

  it('does not guess from global focus when owning session context is absent', () => {
    expect(resolveBubbleProjectPath(sessions, undefined, 'left')).toBeUndefined()
  })
})
