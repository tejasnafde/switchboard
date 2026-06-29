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
  // The machine registry is this laptop's list of remotes, not the VM's.
  ...Object.values(MachineChannels),
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
