/**
 * The backend's Snooze presets: a read falls back to the defaults, a write is
 * checked whole and broadcast only when it changed the list, and the generic
 * settings channels take the same path.
 */
import { createMigratedDb } from './helpers/test-db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppChannels } from '../../src/shared/ipc-channels'
import { BACKEND_CAPABILITIES } from '../../src/shared/ws-protocol'
import {
  CHAT_SNOOZE_PRESETS_CAPABILITY,
  DEFAULT_SNOOZE_PRESETS,
  SNOOZE_PRESETS_SETTING,
  checkPresetList,
  presetListRefusalText,
} from '../../src/shared/chat-snooze'
import { getSetting, setSetting } from '../../src/main/db/database'

vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end: () => {} }) }))

const { readSnoozePresets, writeSnoozePresets } = await import('../../src/main/conversations/snooze-presets')
const { registerAppHandlers } = await import('../../src/main/ipc/app')

const lunch = { label: 'Lunch', kind: 'time', dayOffset: 0, hour: 13, minute: 0 } as const
const evening = { label: 'Evening', kind: 'weekday', weekday: 5, hour: 18, minute: 30 } as const

function host() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const emitted: Array<[string, unknown]> = []
  registerAppHandlers({
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    emit: (channel: string, payload: unknown) => emitted.push([channel, payload]),
  } as never)
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args)
  return { call, emitted, presetEvents: () => emitted.filter(([c]) => c === AppChannels.SNOOZE_PRESETS_CHANGED) }
}

beforeEach(() => {
  createMigratedDb()
})

describe('reading the presets', () => {
  it('is the defaults with no row, an unreadable row or a row with nothing usable', () => {
    expect(readSnoozePresets()).toEqual(DEFAULT_SNOOZE_PRESETS)
    setSetting(SNOOZE_PRESETS_SETTING, '{not json')
    expect(readSnoozePresets()).toEqual(DEFAULT_SNOOZE_PRESETS)
    setSetting(SNOOZE_PRESETS_SETTING, JSON.stringify([{ label: '' }]))
    expect(readSnoozePresets()).toEqual(DEFAULT_SNOOZE_PRESETS)
  })

  it('drops the entries that are not presets', () => {
    setSetting(SNOOZE_PRESETS_SETTING, JSON.stringify([lunch, { label: 'Odd', kind: 'month' }, evening]))
    expect(readSnoozePresets()).toEqual([lunch, evening])
  })
})

describe('writing the presets', () => {
  it('stores the checked list, trimmed and without other fields, and broadcasts it', () => {
    const emit = vi.fn()
    const result = writeSnoozePresets([{ ...lunch, label: '  Lunch ', extra: 1 }, evening], emit)
    expect(result).toEqual({ ok: true, presets: [lunch, evening] })
    expect(JSON.parse(getSetting(SNOOZE_PRESETS_SETTING)!)).toEqual([lunch, evening])
    expect(emit).toHaveBeenCalledWith(AppChannels.SNOOZE_PRESETS_CHANGED, { presets: [lunch, evening] })
  })

  it('does not broadcast a write that leaves the list as it was', () => {
    const emit = vi.fn()
    writeSnoozePresets([...DEFAULT_SNOOZE_PRESETS], emit)
    expect(emit).not.toHaveBeenCalled()
  })

  it('refuses a list it would have to repair, with a reason, and keeps the stored one', () => {
    const emit = vi.fn()
    writeSnoozePresets([lunch], emit)
    emit.mockClear()
    expect(writeSnoozePresets('lunch', emit)).toEqual({ ok: false, reason: 'not_a_list' })
    expect(writeSnoozePresets([], emit)).toEqual({ ok: false, reason: 'empty' })
    expect(writeSnoozePresets(Array(9).fill(lunch), emit)).toEqual({ ok: false, reason: 'too_many' })
    expect(writeSnoozePresets([lunch, { ...evening, weekday: 7 }], emit)).toEqual({
      ok: false,
      reason: 'invalid_preset',
      index: 1,
    })
    expect(readSnoozePresets()).toEqual([lunch])
    expect(emit).not.toHaveBeenCalled()
  })

  it('accepts the limits of the parser: 40 characters, 5 minutes and 365 days', () => {
    const at = (minutes: number) => ({ label: 'x'.repeat(40), kind: 'duration', minutes })
    expect(checkPresetList([at(5), at(365 * 1440)]).ok).toBe(true)
    expect(checkPresetList([at(4)]).ok).toBe(false)
    expect(checkPresetList([at(365 * 1440 + 1)]).ok).toBe(false)
    expect(checkPresetList([{ ...at(60), label: 'x'.repeat(41) }]).ok).toBe(false)
  })
})

describe('the preset channels', () => {
  it('reads, writes and broadcasts through app:get-snooze-presets and app:set-snooze-presets', () => {
    const backend = host()
    expect(backend.call(AppChannels.GET_SNOOZE_PRESETS)).toEqual(DEFAULT_SNOOZE_PRESETS)
    expect(backend.call(AppChannels.SET_SNOOZE_PRESETS, [lunch])).toEqual({ ok: true, presets: [lunch] })
    expect(backend.call(AppChannels.GET_SNOOZE_PRESETS)).toEqual([lunch])
    expect(backend.presetEvents()).toEqual([[AppChannels.SNOOZE_PRESETS_CHANGED, { presets: [lunch] }]])
    expect(backend.call(AppChannels.SET_SNOOZE_PRESETS, [{ label: 'Bad' }])).toEqual({
      ok: false,
      reason: 'invalid_preset',
      index: 0,
    })
    expect(backend.presetEvents()).toHaveLength(1)
  })

  it('checks a settings:set of the row the same way, and settings:remove brings the defaults back', () => {
    const backend = host()
    expect(() => backend.call(AppChannels.SETTINGS_SET, SNOOZE_PRESETS_SETTING, '[]')).toThrow(
      presetListRefusalText('empty'),
    )
    expect(() => backend.call(AppChannels.SETTINGS_SET, SNOOZE_PRESETS_SETTING, 'nope')).toThrow(
      presetListRefusalText('not_a_list'),
    )
    expect(getSetting(SNOOZE_PRESETS_SETTING)).toBeNull()
    backend.call(AppChannels.SETTINGS_SET, SNOOZE_PRESETS_SETTING, JSON.stringify([evening]))
    expect(readSnoozePresets()).toEqual([evening])
    backend.call('settings:remove', SNOOZE_PRESETS_SETTING)
    expect(readSnoozePresets()).toEqual(DEFAULT_SNOOZE_PRESETS)
    expect(backend.presetEvents().map(([, e]) => e)).toEqual([
      { presets: [evening] },
      { presets: [...DEFAULT_SNOOZE_PRESETS] },
    ])
  })

  it('is announced, so a phone asks only a backend that has it', () => {
    expect(BACKEND_CAPABILITIES).toContain(CHAT_SNOOZE_PRESETS_CAPABILITY)
  })
})
