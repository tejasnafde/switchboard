import { describe, expect, it } from 'vitest'
import { commandTargetSessionId, snoozeCommands } from '../../src/renderer/components/CommandPalette'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { useLayoutStore } from '../../src/renderer/stores/layout-store'
import { useSnoozePresetsStore } from '../../src/renderer/stores/snooze-presets-store'
import { DEFAULT_SNOOZE_PRESETS } from '../../src/shared/chat-snooze'
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

  it('ends with the custom date and time entry', () => {
    focus('c1')
    expect(snoozeCommands(new Date(2026, 10, 2, 10), () => {}).at(-1)).toMatchObject({
      id: 'chat.snooze.custom',
      label: 'Snooze chat: custom date and time',
    })
  })

  it('lists the stored presets, soonest first, as the backend last sent them', () => {
    focus('c1')
    useSnoozePresetsStore.getState().take([
      { label: 'Friday wrap-up', kind: 'weekday', weekday: 5, hour: 16, minute: 0 },
      { label: 'After lunch', kind: 'time', dayOffset: 0, hour: 14, minute: 0 },
    ])
    try {
      const labels = snoozeCommands(new Date(2026, 10, 2, 10), () => {}).map((c) => [c.label, c.shortcut])
      expect(labels).toEqual([
        ['Snooze chat: After lunch', '14:00'],
        ['Snooze chat: Friday wrap-up', 'Fri 16:00'],
        ['Snooze chat: custom date and time', undefined],
      ])
    } finally {
      useSnoozePresetsStore.setState({ presets: DEFAULT_SNOOZE_PRESETS, loaded: false })
    }
  })

  it('offers none for the landing draft, which has no stored row', () => {
    focus(draftSessionId('local', '/repo'))
    expect(snoozeCommands(new Date(2026, 10, 2, 10), () => {})).toEqual([])
  })
})
