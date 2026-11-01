/**
 * The desktop's hub client to other machines (`RemoteHubClients`), its
 * describe cache, and the `list_machines` text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const { WsHost } = await import('../../src/main/backend/ws-host')
const { RemoteHubClients } = await import('../../src/main/hub/remote-hub-clients')
const { buildListMachinesTool, LIST_MACHINES_TOOL } = await import('../../src/main/mcp/hub-tools')
const { HubRemoteChannels } = await import('../../src/shared/ipc-channels')
const { formatHubMachineList, remoteUrlKey } = await import('../../src/shared/hub-remote')

import type { ConnectionStatus } from '../../src/main/machines/connection-status'
import type { HubMachineDescription, HubMachineEntry } from '../../src/shared/hub-remote'
import type { TransportSocket } from '../../src/shared/ws-transport'
import type { RemoteHubClientsDeps } from '../../src/main/hub/remote-hub-clients'

const TOKEN = 'server-token-abc'

function description(over: Partial<HubMachineDescription> = {}): HubMachineDescription {
  return {
    v: 1,
    flagOn: true,
    os: 'linux',
    arch: 'x64',
    backendVersion: '1.0.0',
    agents: [
      {
        agent: 'claude-code',
        accounts: [{ instanceId: 'claude-work', name: 'Work' }],
        models: ['model-a', 'model-b'],
      },
    ],
    projects: [
      { path: '~/projects/app', branch: 'main', remoteUrls: ['https://github.com/acme/app.git'] },
      { path: '~/projects/other', branch: 'dev', remoteUrls: ['github.com:acme/other.git'] },
    ],
    freeDiskBytes: 50 * 1024 ** 3,
    openChildren: 1,
    runSlots: [{ instanceId: 'claude-work', running: 1, limit: 3 }],
    ...over,
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

async function boot(): Promise<{ host: InstanceType<typeof WsHost>; url: string }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const host = new WsHost(wss, TOKEN)
  cleanups.push(() => {
    host.dispose()
    wss.close()
  })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  return { host, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` }
}

/** A socket like an older backend sees: the auth frame arrives without `scopes`. */
function olderBackendSocket(url: string): TransportSocket {
  const ws = new WebSocket(url)
  const send = ws.send.bind(ws)
  ws.send = ((data: string) => {
    const frame = JSON.parse(data) as Record<string, unknown>
    if (frame.k === 'auth') delete frame.scopes
    send(JSON.stringify(frame))
  }) as typeof ws.send
  return ws as unknown as TransportSocket
}

function clients(url: string | null, over: Partial<RemoteHubClientsDeps> = {}) {
  const state = { status: 'connected' as ConnectionStatus, enabled: true, now: 1_000_000 }
  const hub = new RemoteHubClients({
    enabled: () => state.enabled,
    machines: () => [{ id: 'm1', name: 'Work VM', transportKind: 'gcloud-iap' }],
    statusOf: () => state.status,
    urlOf: () => (state.status === 'connected' ? url : null),
    tokenOf: () => (state.status === 'connected' ? TOKEN : null),
    now: () => state.now,
    ...over,
  })
  cleanups.push(() => hub.closeAll())
  return { hub, state }
}

describe('RemoteHubClients auth', () => {
  it('connects with the hub grant and calls hub-remote channels', async () => {
    const { host, url } = await boot()
    host.handle(HubRemoteChannels.DESCRIBE, () => description())
    const { hub } = clients(url)
    const seen: unknown[][] = []
    hub.on(HubRemoteChannels.OUTBOX, (...args) => seen.push(args))
    expect(await hub.invoke('m1', HubRemoteChannels.DESCRIBE)).toEqual(description())
    host.emit(HubRemoteChannels.OUTBOX, 'x')
    await vi.waitFor(() => expect(seen).toEqual([['m1', 'x']]))
  })

  it('refuses a backend that grants the full token scopes instead of hub', async () => {
    const { host, url } = await boot()
    host.handle(HubRemoteChannels.DESCRIBE, () => description())
    const { hub } = clients(url, { createSocket: olderBackendSocket })
    await expect(hub.invoke('m1', HubRemoteChannels.DESCRIBE)).rejects.toThrow('update the backend on Work VM')
    const [entry] = await hub.entries()
    expect(entry).toMatchObject({ status: 'error', problem: 'update the backend on Work VM', description: null })
  })

  it('refuses at once when the machine is not connected, and opens nothing with the flag off', async () => {
    const created: string[] = []
    const { hub, state } = clients('ws://127.0.0.1:1', {
      createSocket: (u) => {
        created.push(u)
        return new WebSocket(u) as unknown as TransportSocket
      },
    })
    state.status = 'offline'
    await expect(hub.invoke('m1', HubRemoteChannels.DESCRIBE)).rejects.toThrow('Work VM is not connected')
    state.status = 'connected'
    state.enabled = false
    hub.statusChanged('m1', 'connected')
    await hub.entries()
    await expect(hub.invoke('m1', HubRemoteChannels.DESCRIBE)).rejects.toThrow('hub_remote_children is off')
    expect(created).toEqual([])
  })

  it('fails a call that gets no answer within the timeout', async () => {
    const { host, url } = await boot()
    host.handle(HubRemoteChannels.DESCRIBE, () => new Promise(() => {}))
    const { hub } = clients(url, { callTimeoutMs: 150 })
    await expect(hub.invoke('m1', HubRemoteChannels.DESCRIBE)).rejects.toThrow(
      'Work VM did not answer hub-remote:describe',
    )
  })
})

describe('the describe cache', () => {
  it('reads on connect, at most every 60 s on demand, keeps the snapshot offline and never caches a failure', async () => {
    const { host, url } = await boot()
    let calls = 0
    let fail = false
    host.handle(HubRemoteChannels.DESCRIBE, () => {
      calls++
      if (fail) throw new Error('boom')
      return description({ openChildren: calls })
    })
    const { hub, state } = clients(url)

    hub.statusChanged('m1', 'connected')
    await vi.waitFor(() => expect(hub.snapshotOf('m1')).not.toBeNull())
    expect(calls).toBe(1)

    state.now += 30_000
    let [entry] = await hub.entries()
    expect(calls).toBe(1)
    expect(entry.ageMs).toBe(30_000)

    state.now += 30_000
    ;[entry] = await hub.entries()
    expect(calls).toBe(2)
    expect(entry.description?.openChildren).toBe(2)
    expect(entry.ageMs).toBe(0)

    // A failed read keeps the last answer and is tried again on the next call.
    state.now += 61_000
    fail = true
    ;[entry] = await hub.entries()
    expect(calls).toBe(3)
    expect(entry.description?.openChildren).toBe(2)
    expect(entry.ageMs).toBe(61_000)
    ;[entry] = await hub.entries()
    expect(calls).toBe(4)

    // A reconnect reads again at once, whatever the age.
    fail = false
    hub.statusChanged('m1', 'connected')
    await vi.waitFor(() => expect(hub.snapshotOf('m1')?.description.openChildren).toBe(5))

    // Offline: the last snapshot stays, with its age.
    state.status = 'offline'
    hub.statusChanged('m1', 'offline')
    state.now += 3_600_000
    ;[entry] = await hub.entries()
    expect(calls).toBe(5)
    expect(entry).toMatchObject({ status: 'offline', ageMs: 3_600_000 })
    expect(entry.description?.openChildren).toBe(5)

    hub.remove('m1')
    expect(hub.snapshotOf('m1')).toBeNull()
  })
})

describe('list_machines text', () => {
  const remote = (over: Partial<HubMachineEntry> = {}): HubMachineEntry => ({
    id: 'm1',
    name: 'Work VM',
    transport: 'gcloud-iap',
    status: 'connected',
    description: description(),
    ageMs: 5_000,
    problem: null,
    ...over,
  })

  it('keys every form of a remote URL the same', () => {
    const forms = [
      'https://github.com/acme/app.git',
      'https://token@github.com/acme/app',
      'git@github.com:acme/app.git',
      'github.com:acme/app',
      'ssh://git@github.com:22/acme/app.git',
      'HTTPS://GitHub.com/Acme/App/',
    ]
    for (const f of forms) expect(remoteUrlKey(f), f).toBe('github.com/acme/app')
    expect(remoteUrlKey('/home/u/app.git')).toBeNull()
  })

  it('puts this desktop first and writes no infrastructure name', async () => {
    const machineRow = {
      id: 'm1',
      name: 'Work VM',
      sshAlias: 'secret-alias',
      transportKind: 'gcloud-iap' as const,
      iapInstance: 'vm-instance-7',
      iapProject: 'prj-hidden-123',
      iapZone: 'asia-south1-a',
      user: 'tejas',
      host: 'vm.internal.example',
    }
    const { host, url } = await boot()
    host.handle(HubRemoteChannels.DESCRIBE, () => description())
    const { hub } = clients(url, { machines: () => [machineRow] })
    const tool = buildListMachinesTool({
      projectPath: () => '/repo',
      describeLocal: async () =>
        description({
          os: 'darwin',
          arch: 'arm64',
          projects: [{ path: '~/code/app', branch: 'feat', remoteUrls: ['git@github.com:acme/app.git'] }],
        }),
      remoteEntries: () => hub.entries(),
      remoteUrls: async () => ['git@github.com:acme/app.git'],
    })
    expect(tool.name).toBe(LIST_MACHINES_TOOL)
    expect(tool.annotations.readOnlyHint).toBe(true)
    const result = await tool.call({}, { signal: new AbortController().signal })
    const text = (result.content[0] as { text: string }).text
    expect(text.indexOf('local: This desktop')).toBeLessThan(text.indexOf('m1: Work VM'))
    expect(text).toContain('transport local, connected')
    expect(text).toContain('transport gcloud-iap, connected')
    expect(text).toContain("projects with this chat's remote: ~/code/app (feat)")
    expect(text).toContain("projects with this chat's remote: ~/projects/app (main)")
    expect(text).not.toContain('~/projects/other')
    expect(text).toContain('claude-code: accounts claude-work (Work); models model-a, model-b')
    expect(text).toContain('free disk 50.0 GB, open children 1')
    expect(text).toContain('free run slots: claude-work 2 of 3')
    for (const secret of ['secret-alias', 'vm-instance-7', 'prj-hidden-123', 'asia-south1-a', 'tejas', 'vm.internal'])
      expect(text).not.toContain(secret)
  })

  it('says when a machine takes no children, needs an update, or is offline with its age', () => {
    const text = formatHubMachineList(
      [
        remote({ description: description({ flagOn: false }) }),
        remote({
          id: 'm2',
          name: 'Old VM',
          status: 'error',
          description: null,
          problem: 'update the backend on Old VM',
        }),
        remote({ id: 'm3', name: 'Laptop', transport: 'ssh', status: 'offline', ageMs: 2 * 3_600_000 }),
      ],
      ['https://github.com/acme/app'],
    )
    expect(text).toContain('does not take children: hub_remote_children is off there')
    expect(text).toContain(
      'm2: Old VM\n  transport gcloud-iap, error, not described yet\n  update the backend on Old VM',
    )
    expect(text).toContain('m3: Laptop\n  transport ssh, offline, described 2 h ago')
    expect(formatHubMachineList([remote()], [])).toContain("none (this chat's project has no git remote)")
  })
})
