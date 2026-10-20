/**
 * The rules behind the Paired devices list: search, sort, the "Online now" and
 * "Earlier" groups, the inactive fold, and how dates read. Pure, so the tab
 * only renders.
 */
import { deviceDisplayName, type DeviceSessionView } from '@shared/device-auth'

/** Not connected for this long, the device folds away and "Revoke inactive" offers it. */
export const INACTIVE_AFTER_MS = 30 * 24 * 60 * 60_000

export type DeviceSort = 'lastSeen' | 'name' | 'paired'

export const DEVICE_SORT_OPTIONS: ReadonlyArray<{ value: DeviceSort; label: string }> = [
  { value: 'lastSeen', label: 'Last seen' },
  { value: 'name', label: 'Name' },
  { value: 'paired', label: 'Paired' },
]

export function isInactive(device: DeviceSessionView, nowMs: number): boolean {
  return !device.online && nowMs - device.lastSeenAt >= INACTIVE_AFTER_MS
}

export function platformLabel(device: Pick<DeviceSessionView, 'platform'>): string | undefined {
  if (device.platform === 'ios') return 'iOS'
  if (device.platform === 'android') return 'Android'
  return undefined
}

/** "Google Pixel 9", or whichever half the phone reported. */
export function makeAndModel(device: Pick<DeviceSessionView, 'manufacturer' | 'model'>): string | undefined {
  const parts = [device.manufacturer, device.model].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** Search matches the name (custom or reported), make and model, and platform. */
export function matchesDeviceSearch(device: DeviceSessionView, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [deviceDisplayName(device), device.name, makeAndModel(device), platformLabel(device)]
    .filter((field): field is string => !!field)
    .some((field) => field.toLowerCase().includes(needle))
}

function compareDevices(sort: DeviceSort): (a: DeviceSessionView, b: DeviceSessionView) => number {
  if (sort === 'name') return (a, b) => deviceDisplayName(a).localeCompare(deviceDisplayName(b))
  if (sort === 'paired') return (a, b) => b.createdAt - a.createdAt
  return (a, b) => b.lastSeenAt - a.lastSeenAt
}

export interface DeviceGroups {
  online: DeviceSessionView[]
  /** Not online, seen within INACTIVE_AFTER_MS, or any match while searching. */
  earlier: DeviceSessionView[]
  /** Behind the "Show N more inactive devices" fold. Empty while searching:
   *  a match hidden behind a fold reads as no match. */
  folded: DeviceSessionView[]
  /** Every inactive device, search or not: what "Revoke inactive" removes. */
  inactive: DeviceSessionView[]
}

export function groupDevices(
  devices: readonly DeviceSessionView[],
  query: string,
  sort: DeviceSort,
  nowMs: number,
): DeviceGroups {
  const live = devices.filter((d) => !d.revoked)
  const searching = query.trim() !== ''
  const shown = live.filter((d) => matchesDeviceSearch(d, query)).sort(compareDevices(sort))
  return {
    online: shown.filter((d) => d.online),
    earlier: shown.filter((d) => !d.online && (searching || !isInactive(d, nowMs))),
    folded: searching ? [] : shown.filter((d) => isInactive(d, nowMs)),
    inactive: live.filter((d) => isInactive(d, nowMs)).sort(compareDevices('lastSeen')),
  }
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`

/** For rows: "3 days ago". */
export function relativeTime(ms: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return plural(hours, 'hour')
  return plural(Math.floor(hours / 24), 'day')
}

// ponytail: fixed English months. Intl's en-GB writes "Sept", which the mock does not.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** For Details and dialogs: "17 Oct 2026", or "17 Oct 2026, 09:41" with the time. */
export function absoluteDate(ms: number, withTime = false): string {
  const d = new Date(ms)
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
  if (!withTime) return date
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * What a Rename save should send: `undefined` for no call (the name did not
 * change), `null` to clear the custom name (empty, or the phone's own name, so
 * a later name the phone reports is not hidden by a stored copy), else the
 * trimmed custom name.
 */
export function renameValue(draft: string, current: string, reported: string): string | null | undefined {
  const next = draft.trim()
  if (next === current) return undefined
  if (next === '' || next === reported) return null
  return next
}
