import { describe, expect, it } from 'vitest'
import { commandTargetSessionId } from '../../src/renderer/components/CommandPalette'

describe('command palette session routing', () => {
  it('targets the focused chat and falls back to the primary slot', () => {
    expect(commandTargetSessionId({
      primarySessionId: 'left',
      secondarySessionId: 'right',
      focusedChatSlot: 'secondary',
    })).toBe('right')
    expect(commandTargetSessionId({
      primarySessionId: 'left',
      secondarySessionId: null,
      focusedChatSlot: 'secondary',
    })).toBe('left')
  })
})
