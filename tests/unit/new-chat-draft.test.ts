import { describe, expect, it } from 'vitest'
import { draftSessionId, isDraftSessionId } from '@shared/new-chat-draft'

describe('new chat draft ids', () => {
  it('is stable per machine and project, so persisted draft text comes back', () => {
    expect(draftSessionId('local', '/a/b')).toBe(draftSessionId('local', '/a/b'))
    expect(draftSessionId('local', '/a/b')).not.toBe(draftSessionId('vm1', '/a/b'))
  })
  it('never matches a real conversation id', () => {
    expect(isDraftSessionId(draftSessionId('local', '/a'))).toBe(true)
    for (const id of ['agent_1712', '3f2a9c1e-0000-4000-8000-000000000000', '', null, undefined]) {
      expect(isDraftSessionId(id)).toBe(false)
    }
  })
})
