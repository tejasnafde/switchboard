import { describe, expect, it } from 'vitest'
import { commandTargetSessionId, snoozeCommands } from '../../src/renderer/components/CommandPalette'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { useLayoutStore } from '../../src/renderer/stores/layout-store'
import { draftSessionId } from '../../src/shared/new-chat-draft'

describe('command palette session routing', () => {
  it('targets the focused chat and falls back to the primary slot', () => {
    expect(
      commandTargetSessionId({
        primarySessionId: 'left',
        secondarySessionId: 'right',
        focusedChatSlot: 'secondary',
      }),
    ).toBe('right')
    expect(
      commandTargetSessionId({
        primarySessionId: 'left',
        secondarySessionId: null,
        focusedChatSlot: 'secondary',
      }),
    ).toBe('left')
  })
})

describe('palette Snooze entries', () => {
  const focus = (id: string) => {
    useLayoutStore.setState({ primarySessionId: id, secondarySessionId: null, focusedChatSlot: 'primary' })
    useAgentStore.setState({ sessions: [{ id, title: 'Chat', status: 'idle', messages: [] } as never] })
  }

  it('lists the presets for a stored chat', () => {
    focus('c1')
    expect(snoozeCommands(new Date(2026, 10, 2, 10), () => {}).length).toBeGreaterThan(0)
  })

  it('offers none for the landing draft, which has no stored row', () => {
    focus(draftSessionId('local', '/repo'))
    expect(snoozeCommands(new Date(2026, 10, 2, 10), () => {})).toEqual([])
  })
})
