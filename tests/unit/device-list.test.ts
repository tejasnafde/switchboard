/** The Paired devices list rules: groups, search, the inactive fold, sort, dates and pull request writes. */
import { describe, it, expect } from 'vitest'
import type { DeviceSessionView } from '@shared/device-auth'
import {
  renameValue,
  INACTIVE_AFTER_MS,
  absoluteDate,
  groupDevices,
  hasPrWrite,
  isInactive,
  matchesDeviceSearch,
  prWriteConfirm,
  prWriteDescription,
  relativeTime,
} from '../../src/renderer/components/settings/device-list'

const NOW = new Date(2026, 9, 20, 12, 0).getTime()
const DAY = 24 * 60 * 60_000

function device(id: string, over: Partial<DeviceSessionView>): DeviceSessionView {
  return { id, label: 'device', scopes: ['chat'], createdAt: NOW - 60 * DAY, lastSeenAt: NOW, revoked: false, ...over }
}

const pixel = device('pixel', {
  name: "Tejas's Pixel 9",
  manufacturer: 'Google',
  model: 'Pixel 9',
  platform: 'android',
  online: true,
})
const iphone = device('iphone', {
  name: 'iPhone',
  customName: "Tejas's iPhone",
  manufacturer: 'Apple',
  model: 'iPhone 16',
  platform: 'ios',
  online: true,
  lastSeenAt: NOW - 1000,
})
const galaxy = device('galaxy', {
  name: 'Galaxy S24',
  manufacturer: 'Samsung',
  model: 'Galaxy S24',
  platform: 'android',
  lastSeenAt: NOW - 3 * DAY,
})
const oneplus = device('oneplus', {
  name: 'OnePlus 12',
  manufacturer: 'OnePlus',
  model: 'CPH2583',
  platform: 'android',
  lastSeenAt: NOW - 34 * DAY,
})
const pixel7a = device('pixel7a', {
  name: 'Pixel 7a',
  manufacturer: 'Google',
  model: 'Pixel 7a',
  platform: 'android',
  lastSeenAt: NOW - 52 * DAY,
})
const revoked = device('gone', { name: 'Old phone', lastSeenAt: NOW - 90 * DAY, revoked: true })
const all = [pixel7a, galaxy, revoked, oneplus, iphone, pixel]

const ids = (list: DeviceSessionView[]): string[] => list.map((d) => d.id)

describe('groupDevices', () => {
  it('splits online, earlier and folded inactive devices, newest first', () => {
    const groups = groupDevices(all, '', 'lastSeen', NOW)
    expect(ids(groups.online)).toEqual(['pixel', 'iphone'])
    expect(ids(groups.earlier)).toEqual(['galaxy'])
    expect(ids(groups.folded)).toEqual(['oneplus', 'pixel7a'])
    expect(ids(groups.inactive)).toEqual(['oneplus', 'pixel7a'])
  })

  it('leaves revoked devices out', () => {
    const groups = groupDevices(all, '', 'lastSeen', NOW)
    expect([...groups.online, ...groups.earlier, ...groups.folded].some((d) => d.id === 'gone')).toBe(false)
  })

  it('shows inactive matches unfolded while searching, and still counts every inactive device', () => {
    const groups = groupDevices(all, 'oneplus', 'lastSeen', NOW)
    expect(ids(groups.earlier)).toEqual(['oneplus'])
    expect(groups.folded).toEqual([])
    expect(ids(groups.inactive)).toEqual(['oneplus', 'pixel7a'])
  })

  it('sorts by name and by paired date', () => {
    expect(ids(groupDevices(all, '', 'name', NOW).online)).toEqual(['iphone', 'pixel'])
    const paired = [device('a', { createdAt: 1 }), device('b', { createdAt: 2 })]
    expect(ids(groupDevices(paired, '', 'paired', NOW).earlier)).toEqual(['b', 'a'])
  })
})

describe('isInactive', () => {
  it('is 30 days without a connection, never while online', () => {
    expect(isInactive(device('x', { lastSeenAt: NOW - INACTIVE_AFTER_MS }), NOW)).toBe(true)
    expect(isInactive(device('x', { lastSeenAt: NOW - INACTIVE_AFTER_MS + 1 }), NOW)).toBe(false)
    expect(isInactive(device('x', { lastSeenAt: NOW - 90 * DAY, online: true }), NOW)).toBe(false)
  })
})

describe('matchesDeviceSearch', () => {
  it('matches the custom and reported name, make and model, and platform, case blind', () => {
    expect(matchesDeviceSearch(iphone, "tejas's")).toBe(true)
    expect(matchesDeviceSearch(iphone, 'iphone 16')).toBe(true)
    expect(matchesDeviceSearch(iphone, 'apple')).toBe(true)
    expect(matchesDeviceSearch(iphone, 'IOS')).toBe(true)
    expect(matchesDeviceSearch(oneplus, 'cph2583')).toBe(true)
    expect(matchesDeviceSearch(pixel, 'tab')).toBe(false)
    expect(matchesDeviceSearch(pixel, '   ')).toBe(true)
  })
})

describe('dates', () => {
  it('reads relative in rows', () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe('just now')
    expect(relativeTime(NOW - 60_000, NOW)).toBe('1 minute ago')
    expect(relativeTime(NOW - 5 * 3_600_000, NOW)).toBe('5 hours ago')
    expect(relativeTime(NOW - DAY, NOW)).toBe('1 day ago')
    expect(relativeTime(NOW - 34 * DAY, NOW)).toBe('34 days ago')
  })

  it('reads absolute in Details and dialogs', () => {
    expect(absoluteDate(new Date(2026, 8, 16, 9, 5).getTime())).toBe('16 Sep 2026')
    expect(absoluteDate(new Date(2026, 9, 17, 9, 41).getTime(), true)).toBe('17 Oct 2026, 09:41')
  })
})

describe('renameValue', () => {
  it('makes no call when the name did not change', () => {
    expect(renameValue('Pixel 9', 'Pixel 9', 'Pixel 9')).toBeUndefined()
    expect(renameValue('  Work phone ', 'Work phone', 'Pixel 9')).toBeUndefined()
  })
  it('clears the custom name for an empty draft or the reported name', () => {
    expect(renameValue('', 'Work phone', 'Pixel 9')).toBeNull()
    expect(renameValue(' Pixel 9 ', 'Work phone', 'Pixel 9')).toBeNull()
  })
  it('stores a new trimmed name', () => {
    expect(renameValue('  Tejas phone ', 'Pixel 9', 'Pixel 9')).toBe('Tejas phone')
  })
})

describe('pull request writes', () => {
  const writer = { ...iphone, scopes: [...iphone.scopes, 'pr-write' as const] }

  it('shows the badge only for a device with the pr-write scope', () => {
    expect(hasPrWrite(iphone)).toBe(false)
    expect(hasPrWrite(writer)).toBe(true)
  })
  it('describes what a grant gives, before it is given', () => {
    expect(prWriteDescription(iphone, NOW)).toBe(
      'Comment, reply, resolve and review as you, from this phone. Never merge.',
    )
  })
  it('reads Allowed, with the last write when there is one', () => {
    expect(prWriteDescription(writer, NOW)).toBe('Allowed.')
    expect(prWriteDescription({ ...writer, lastPrWriteAt: NOW - 3 * 60 * 60_000 }, NOW)).toBe(
      'Allowed. Last write: 3 hours ago.',
    )
  })
  it('names the risk in the grant confirm', () => {
    const ask = prWriteConfirm(iphone)
    expect(ask.title).toBe("Let Tejas's iPhone write to pull requests?")
    expect(ask.confirmLabel).toBe('Allow writes')
    expect(ask.destructive).toBeUndefined()
    expect(ask.body).toContain('posts as you on GitHub and Bitbucket')
    expect(ask.body).toContain('Anyone who can unlock the phone')
    expect(ask.body).toContain('Face ID or the passcode')
    expect(ask.items?.map((i) => i.label)).toEqual(['Allowed', 'Stays here'])
    expect(ask.items?.[1]?.detail).toContain('Merge, close')
  })
  it('says an offline phone gets the grant at its next connect', () => {
    expect(prWriteConfirm(iphone).body).not.toContain('offline')
    expect(prWriteConfirm(galaxy).body).toContain('The phone is offline. This takes effect when it next connects.')
  })
})
