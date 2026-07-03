/**
 * HybridTransport routing: desktop-only channels go to the local IPC transport,
 * everything else to the remote backend; `on` subscribes to both so push events
 * arrive regardless of which side owns the channel.
 */
import { describe, it, expect, vi } from 'vitest'
import { HybridTransport } from '../../src/preload/hybrid-transport'
import { AppChannels, ProviderChannels, MachineChannels } from '../../src/shared/ipc-channels'
import type { Transport } from '../../src/shared/transport'

function fake(tag: string) {
  const calls: string[] = []
  const offs: string[] = []
  const t: Transport = {
    invoke: (ch: string) => {
      calls.push(`${tag}:invoke:${ch}`)
      return Promise.resolve(tag)
    },
    send: (ch: string) => calls.push(`${tag}:send:${ch}`),
    on: (ch: string) => {
      calls.push(`${tag}:on:${ch}`)
      return () => offs.push(`${tag}:off:${ch}`)
    },
  }
  return { t, calls, offs }
}

describe('HybridTransport', () => {
  it('routes desktop-only channels to local, others to remote', async () => {
    const local = fake('local')
    const remote = fake('remote')
    const h = new HybridTransport(local.t, remote.t)

    expect(await h.invoke(AppChannels.OPEN_FOLDER)).toBe('local')
    expect(await h.invoke(AppChannels.CHECK_FOR_UPDATES)).toBe('local')
    expect(await h.invoke(MachineChannels.LIST)).toBe('local')
    expect(await h.invoke(ProviderChannels.START_SESSION)).toBe('remote')
    h.send(AppChannels.SET_VIBRANCY, true)
    h.send(ProviderChannels.SEND_TURN, 't1', 'hi')

    expect(local.calls).toEqual([
      `local:invoke:${AppChannels.OPEN_FOLDER}`,
      `local:invoke:${AppChannels.CHECK_FOR_UPDATES}`,
      `local:invoke:${MachineChannels.LIST}`,
      `local:send:${AppChannels.SET_VIBRANCY}`,
    ])
    expect(remote.calls).toEqual([
      `remote:invoke:${ProviderChannels.START_SESSION}`,
      `remote:send:${ProviderChannels.SEND_TURN}`,
    ])
  })

  it('routes desktop-only channels not in AppChannels to local (bare ipcMain listeners)', async () => {
    const local = fake('local')
    const remote = fake('remote')
    const h = new HybridTransport(local.t, remote.t)

    expect(await h.invoke('app:close-window')).toBe('local')
    expect(await h.invoke('app:quit-and-install')).toBe('local')
    expect(await h.invoke('app:get-log-paths')).toBe('local')

    expect(local.calls).toEqual([
      'local:invoke:app:close-window',
      'local:invoke:app:quit-and-install',
      'local:invoke:app:get-log-paths',
    ])
    expect(remote.calls).toEqual([])
  })

  it('on subscribes both sides and unsubscribes both', () => {
    const local = fake('local')
    const remote = fake('remote')
    const h = new HybridTransport(local.t, remote.t)

    const off = h.on(ProviderChannels.EVENT, vi.fn())
    expect(local.calls).toContain(`local:on:${ProviderChannels.EVENT}`)
    expect(remote.calls).toContain(`remote:on:${ProviderChannels.EVENT}`)

    off()
    expect(local.offs).toEqual([`local:off:${ProviderChannels.EVENT}`])
    expect(remote.offs).toEqual([`remote:off:${ProviderChannels.EVENT}`])
  })
})
