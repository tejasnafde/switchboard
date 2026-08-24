import { describe, expect, it } from 'vitest'
import { readStateTargets } from '../../src/renderer/services/readState'

describe('dual-chat read-state routing', () => {
  it('marks both visible chats read but reports only the focused chat as viewed', () => {
    expect(readStateTargets(['left', 'right'], 'right', true)).toEqual({
      markReadSessionIds: ['left', 'right'],
      viewingSessionId: 'right',
    })
  })

  it('withdraws the viewing lease when the app loses focus', () => {
    expect(readStateTargets(['left', 'right'], 'right', false)).toEqual({
      markReadSessionIds: [],
      viewingSessionId: null,
    })
  })

  it('falls back to primary when focused identity is unavailable', () => {
    expect(readStateTargets(['left'], null, true)).toEqual({
      markReadSessionIds: ['left'],
      viewingSessionId: 'left',
    })
  })
})
