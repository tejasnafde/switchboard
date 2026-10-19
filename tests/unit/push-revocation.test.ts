import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMigratedDb } from './helpers/test-db'
import { registerPushHandlers } from '../../src/main/ipc/push'
import { withBackendRequestContext } from '../../src/main/backend/request-context'
import {
  createPairingCode,
  redeemPairingCode,
  listSessions,
  revokeSession,
  setRevocationListener,
} from '../../src/main/backend/device-sessions'
import * as pushRegistry from '../../src/main/push/registry'
import { listDevices } from '../../src/main/push/registry'
import { PushChannels } from '../../src/shared/ipc-channels'

beforeEach(() => {
  createMigratedDb()
})
// An ownerless token can be the revoked phone's own, registered before tokens
// carried an owner, so it goes too. A live legacy phone re-registers on connect.
it('revoking a device deletes its push tokens and every ownerless one, and keeps other phones', () => {
  const code = createPairingCode()
  redeemPairingCode(code.code, 'phone', ['chat'])
  const id = listSessions()[0].id
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerPushHandlers({
    handle: (channel, fn) => {
      handlers.set(channel, fn)
    },
    on: () => {},
    emit: () => {},
  })
  withBackendRequestContext({ clientScope: 'phone', transport: 'remote', deviceSessionId: id }, () => {
    handlers.get(PushChannels.REGISTER)!('ExpoPushToken[phone]', 'phone', 'mac')
  })
  handlers.get(PushChannels.REGISTER)!('ExpoPushToken[legacy]', 'legacy', 'mac')
  const second = createPairingCode()
  redeemPairingCode(second.code, 'second phone', ['chat'])
  withBackendRequestContext(
    { clientScope: 'second', transport: 'remote', deviceSessionId: listSessions()[1].id },
    () => {
      handlers.get(PushChannels.REGISTER)!('ExpoPushToken[second]', 'phone', 'mac')
    },
  )
  revokeSession(id)
  expect(listDevices().map((d) => d.token)).toEqual(['ExpoPushToken[second]'])
})

it('unregister is idempotent and persists the removal without deleting other devices', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerPushHandlers({
    handle: (channel, fn) => {
      handlers.set(channel, fn)
    },
    on: () => {},
    emit: () => {},
  })
  handlers.get(PushChannels.REGISTER)!('ExpoPushToken[phone]', 'phone', 'mac')
  handlers.get(PushChannels.REGISTER)!('ExpoPushToken[other]', 'other', 'mac')
  expect(handlers.get(PushChannels.UNREGISTER)!('ExpoPushToken[phone]')).toEqual({ ok: true })
  handlers.get(PushChannels.UNREGISTER)!('ExpoPushToken[phone]')
  expect(listDevices().map((d) => d.token)).toEqual(['ExpoPushToken[other]'])
})

afterEach(() => {
  vi.restoreAllMocks()
  setRevocationListener(null)
})

it('closes revoked sockets even if push token persistence fails', () => {
  const code = createPairingCode()
  redeemPairingCode(code.code, 'phone', ['chat'])
  const id = listSessions()[0].id
  const close = vi.fn()
  setRevocationListener(close)
  vi.spyOn(pushRegistry, 'unregisterSessionDevices').mockImplementation(() => {
    throw new Error('settings unavailable')
  })
  expect(() => revokeSession(id)).toThrow('settings unavailable')
  expect(close).toHaveBeenCalledWith(id)
})
