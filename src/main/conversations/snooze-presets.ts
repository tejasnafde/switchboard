/**
 * The Snooze menu presets this backend serves (`chats.snoozePresets`, a JSON
 * array of `SnoozePresetSpec`). A read never fails: a missing, unreadable or
 * unusable row reads as the defaults (`parsePresetList`). A write is checked
 * by `checkPresetList` and refused whole; one that changed the stored list is
 * broadcast to every client, so the desktop menus and the phones' sheets
 * follow without a reload.
 */
import { AppChannels } from '@shared/ipc-channels'
import {
  SNOOZE_PRESETS_SETTING,
  checkPresetList,
  parsePresetList,
  type SnoozePresetSpec,
  type SnoozePresetsChangedEvent,
  type SnoozePresetsResult,
} from '@shared/chat-snooze'
import { getSetting, removeSetting, setSetting } from '../db/database'
import { createMainLogger } from '../logger'

const log = createMainLogger('snooze:presets')

type Emit = (channel: string, payload: SnoozePresetsChangedEvent) => void

function storedJson(): unknown {
  const raw = getSetting(SNOOZE_PRESETS_SETTING)
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch (err) {
    log.warn('the stored presets are not JSON; using the defaults', err)
    return undefined
  }
}

export function readSnoozePresets(): SnoozePresetSpec[] {
  return parsePresetList(storedJson())
}

export function writeSnoozePresets(raw: unknown, emit: Emit): SnoozePresetsResult {
  const checked = checkPresetList(raw)
  if (!checked.ok) {
    log.info('preset write refused', { reason: checked.reason, index: checked.index })
    return checked
  }
  const before = JSON.stringify(readSnoozePresets())
  const next = JSON.stringify(checked.presets)
  setSetting(SNOOZE_PRESETS_SETTING, next)
  if (next !== before) emit(AppChannels.SNOOZE_PRESETS_CHANGED, { presets: checked.presets })
  return checked
}

/** `settings:remove` of the row: the defaults again, broadcast when that changed the list. */
export function clearSnoozePresets(emit: Emit): void {
  const before = JSON.stringify(readSnoozePresets())
  removeSetting(SNOOZE_PRESETS_SETTING)
  const presets = readSnoozePresets()
  if (JSON.stringify(presets) !== before) emit(AppChannels.SNOOZE_PRESETS_CHANGED, { presets })
}
