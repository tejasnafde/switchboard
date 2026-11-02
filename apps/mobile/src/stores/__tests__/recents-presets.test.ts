import { DEFAULT_SNOOZE_PRESETS, type SnoozePresetSpec } from '@shared/chat-snooze'
import { getClient } from '../connections'
import { useRecentsStore } from '../recents'
import { snoozeSheetItems } from '../../lib/snooze-sheet'

jest.mock('expo-network', () => ({}))
jest.mock('../connections', () => ({ getClient: jest.fn() }))

const lunch: SnoozePresetSpec = { label: 'Lunch', kind: 'time', dayOffset: 0, hour: 13, minute: 0 }
const friday: SnoozePresetSpec = { label: 'Friday wrap-up', kind: 'weekday', weekday: 5, hour: 16, minute: 0 }

function client(capable: boolean, getSnoozePresets: jest.Mock) {
  return {
    supportsCapability: (cap: string) => capable && cap === 'chat_snooze_presets_v1',
    getProjects: jest.fn().mockResolvedValue([]),
    listLiveSessions: jest.fn().mockResolvedValue([]),
    getSnoozePresets,
  }
}

beforeEach(() => useRecentsStore.setState({ sessions: {}, live: {}, presets: {} }))

test('a refresh reads the presets from a backend that has them', async () => {
  const read = jest.fn().mockResolvedValue([lunch, friday])
  jest.mocked(getClient).mockReturnValue(client(true, read) as never)
  await useRecentsStore.getState().refresh('mac')
  expect(read).toHaveBeenCalledTimes(1)
  expect(useRecentsStore.getState().presets.mac).toEqual([lunch, friday])
})

test('an older backend is not asked, and its sheet keeps the defaults', async () => {
  const read = jest.fn()
  jest.mocked(getClient).mockReturnValue(client(false, read) as never)
  await useRecentsStore.getState().refresh('mac')
  expect(read).not.toHaveBeenCalled()
  expect(useRecentsStore.getState().presets.mac).toBeUndefined()
  const labels = snoozeSheetItems(new Date(2026, 10, 2, 9, 0), null).map((i) => i.label)
  expect(labels).toEqual(DEFAULT_SNOOZE_PRESETS.map((p) => p.label))
})

test('a broadcast replaces the list, a list with nothing usable reads as the defaults, and unpairing forgets it', () => {
  useRecentsStore.getState().setPresets('mac', [lunch])
  expect(useRecentsStore.getState().presets.mac).toEqual([lunch])
  useRecentsStore.getState().setPresets('mac', [{ label: '' }])
  expect(useRecentsStore.getState().presets.mac).toEqual(DEFAULT_SNOOZE_PRESETS)
  useRecentsStore.getState().forget('mac')
  expect(useRecentsStore.getState().presets.mac).toBeUndefined()
})

test('the sheet resolves the machine list, soonest first, with each wake time', () => {
  // Monday 2 November 2026, 10:00.
  const items = snoozeSheetItems(new Date(2026, 10, 2, 10, 0), { key: 'github:acme/app#7', number: 7 }, [friday, lunch])
  expect(items.map((i) => [i.label, i.detail])).toEqual([
    ['Lunch', '13:00'],
    ['Friday wrap-up', 'Fri 16:00'],
    ['Until PR #7 changes', ''],
  ])
})
