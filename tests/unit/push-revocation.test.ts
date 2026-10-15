import { beforeEach, expect, it } from 'vitest'
import { createMigratedDb } from './helpers/test-db'
import { registerPushHandlers } from '../../src/main/ipc/push'
import { withBackendRequestContext } from '../../src/main/backend/request-context'
import {
  createPairingCode,
  redeemPairingCode,
  listSessions,
  revokeSession,
} from '../../src/main/backend/device-sessions'
import { listDevices } from '../../src/main/push/registry'
import { PushChannels } from '../../src/shared/ipc-channels'

beforeEach(() => {
  createMigratedDb()
})
it('revoking a device deletes its push tokens and keeps other phones and legacy tokens', () => {
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
  expect(listDevices().map((d) => d.token)).toEqual(['ExpoPushToken[legacy]', 'ExpoPushToken[second]'])
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
