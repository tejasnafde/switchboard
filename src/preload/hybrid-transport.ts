/**
 * Routes the renderer's calls between a local Electron-IPC transport and a
 * remote WebSocket transport when the backend runs on a VM. A small set of
 * channels (native dialogs, app lifecycle, auto-updater) is served only by the
 * local main process and never exists on a remote backend, so those always go
 * to IPC; everything else goes to the remote backend.
 */
import type { Transport } from '@shared/transport'
import { AppChannels, MachineChannels } from '@shared/ipc-channels'

const LOCAL_CHANNELS = new Set<string>([
  AppChannels.OPEN_FOLDER,
  AppChannels.EXPORT_MARKDOWN,
  AppChannels.RELAUNCH,
  AppChannels.SET_VIBRANCY,
  AppChannels.CHECK_FOR_UPDATES,
  AppChannels.GET_UPDATE_STATUS,
  // Desktop-only, handled by bare ipcMain listeners in main/index.ts - no
  // AppChannels entry because they're not part of the ProviderAdapter-facing API.
  'app:close-window',
  'app:quit-and-install',
  'app:get-log-paths',
  // The machine registry is this laptop's list of remotes, not the VM's.
  ...Object.values(MachineChannels),
  // Pairing and Google minting belong to the machine the user is sitting at.
  // Minting in particular opens a consent browser and writes an OAuth client:
  // routed to a remote backend it would try to open a browser on a headless VM
  // and store the client in the VM's database.
  AppChannels.MOBILE_PAIRING_APPLY,
  AppChannels.MOBILE_PAIRING_STATUS,
  AppChannels.MOBILE_PAIRING_CODE,
  AppChannels.MOBILE_DEVICES,
  AppChannels.MOBILE_DEVICE_REVOKE,
  AppChannels.GOOGLE_MINT,
  AppChannels.GOOGLE_CLIENT_STATUS,
  AppChannels.GOOGLE_CLIENT_SET,
])

export class HybridTransport implements Transport {
  constructor(
    private readonly local: Transport,
    private readonly remote: Transport,
  ) {}

  invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    return (LOCAL_CHANNELS.has(channel) ? this.local : this.remote).invoke<T>(channel, ...args)
  }

  send(channel: string, ...args: unknown[]): void {
    ;(LOCAL_CHANNELS.has(channel) ? this.local : this.remote).send(channel, ...args)
  }

  on<A extends unknown[]>(channel: string, handler: (...args: A) => void): () => void {
    // Subscribe on both: a push event originates from whichever side owns the
    // channel (local menu/window/updater vs remote backend), and only that side
    // ever emits it - so there's no double-delivery.
    const offLocal = this.local.on(channel, handler)
    const offRemote = this.remote.on(channel, handler)
    return () => {
      offLocal()
      offRemote()
    }
  }
}
