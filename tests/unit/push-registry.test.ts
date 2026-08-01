/**
 * Push device registry: stored-value parsing, idempotent registration, and the
 * grouping that lets each device learn which backend notified it.
 */
import { describe, it, expect } from 'vitest'
import { parseDevices, upsertDevice, groupByClientRef, type PushDevice } from '../../src/main/push/registry'

const TOKEN_A = 'ExponentPushToken[aaa]'
const TOKEN_B = 'ExponentPushToken[bbb]'

function dev(token: string, extra: Partial<PushDevice> = {}): PushDevice {
  return { token, registeredAt: 1, ...extra }
}

describe('parseDevices', () => {
  it('reads a stored list', () => {
    const raw = JSON.stringify([dev(TOKEN_A, { label: 'phone' })])
    expect(parseDevices(raw)).toEqual([{ token: TOKEN_A, label: 'phone', registeredAt: 1 }])
  })

  it('returns empty for an absent row', () => {
    expect(parseDevices(null)).toEqual([])
    expect(parseDevices('')).toEqual([])
  })

  it('returns empty rather than throwing on invalid JSON', () => {
    expect(parseDevices('{not json')).toEqual([])
  })

  it('returns empty when the value is not an array', () => {
    expect(parseDevices('{"token":"x"}')).toEqual([])
  })

  it('drops entries whose token is not an Expo token, so junk never reaches the service', () => {
    const raw = JSON.stringify([dev(TOKEN_A), dev('garbage'), { label: 'no token' }, null])
    expect(parseDevices(raw)).toEqual([{ token: TOKEN_A, registeredAt: 1 }])
  })
})

describe('upsertDevice', () => {
  it('adds a new device', () => {
    expect(upsertDevice([], dev(TOKEN_A))).toHaveLength(1)
  })

  it('replaces rather than duplicating when the same token re-registers', () => {
    const next = upsertDevice([dev(TOKEN_A, { label: 'old' })], dev(TOKEN_A, { label: 'new' }))
    expect(next).toHaveLength(1)
    expect(next[0].label).toBe('new')
  })

  it('leaves other devices alone', () => {
    const next = upsertDevice([dev(TOKEN_A), dev(TOKEN_B)], dev(TOKEN_A, { label: 'x' }))
    expect(next.map((d) => d.token).sort()).toEqual([TOKEN_A, TOKEN_B].sort())
  })
})

describe('groupByClientRef', () => {
  it('groups tokens by the id the device registered with', () => {
    const groups = groupByClientRef([
      dev(TOKEN_A, { clientRef: 'conn-1' }),
      dev(TOKEN_B, { clientRef: 'conn-1' }),
      dev('ExponentPushToken[ccc]', { clientRef: 'conn-2' }),
    ])
    expect(groups.get('conn-1')).toEqual([TOKEN_A, TOKEN_B])
    expect(groups.get('conn-2')).toEqual(['ExponentPushToken[ccc]'])
  })

  it('keeps devices that registered before clientRef existed', () => {
    // Their payloads carry no clientRef, so a tap cannot route - but they must
    // still receive the notification.
    const groups = groupByClientRef([dev(TOKEN_A)])
    expect(groups.get(undefined)).toEqual([TOKEN_A])
  })

  it('returns nothing for no devices', () => {
    expect(groupByClientRef([]).size).toBe(0)
  })
})
