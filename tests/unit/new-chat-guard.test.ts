import { describe, it, expect } from 'vitest'
import { newChatKey } from '../../src/renderer/services/newChatGuard'

describe('newChatKey', () => {
  it('defaults machineId to local', () => {
    expect(newChatKey('/repo/a')).toBe(newChatKey('/repo/a', 'local'))
  })

  it('keys the same project on different machines independently', () => {
    expect(newChatKey('/repo/a', 'local')).not.toBe(newChatKey('/repo/a', 'vm-1'))
  })

  it('cannot collide across the machine/path field boundary', () => {
    // A path suffix that textually contains another machine id must not
    // produce the same key as that machine + the shorter path.
    expect(newChatKey('/repo', 'm:a')).not.toBe(newChatKey('a:/repo', 'm'))
  })
})
