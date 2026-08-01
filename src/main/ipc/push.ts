/**
 * Push registration handlers. Available on both hosts, since a phone may pair
 * with the desktop app or with a headless server on a VM.
 */
import { PushChannels } from '@shared/ipc-channels'
import type { BackendHost } from '../backend/host'
import { createMainLogger } from '../logger'
import { listDevices, registerDevice, setViewing, unregisterDevice, type PushDevice } from '../push/registry'

const log = createMainLogger('ipc:push')

export function registerPushHandlers(host: BackendHost): void {
  host.handle(PushChannels.REGISTER, (token: string, label?: string, clientRef?: string) => {
    const result = registerDevice(token, label, clientRef)
    if (!result.ok) log.warn(`register rejected: ${result.error}`)
    return result
  })

  host.handle(PushChannels.UNREGISTER, (token: string) => {
    unregisterDevice(token)
    return { ok: true }
  })

  // `ref` is a push token from a phone, or DESKTOP_VIEWER_REF from the desktop,
  // which has no token of its own.
  host.handle(PushChannels.VIEWING, (ref: string, threadId: string | null) => {
    setViewing(ref, threadId)
    return { ok: true }
  })

  // Tokens are omitted: the caller only needs to see what is registered.
  host.handle(PushChannels.LIST, () =>
    listDevices().map((d: PushDevice) => ({ label: d.label, registeredAt: d.registeredAt })),
  )
}
