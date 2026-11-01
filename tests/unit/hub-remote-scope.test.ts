/**
 * Scope `hub`: what one desktop's hub client holds on another machine's
 * backend. It opens `hub-remote:*` and nothing else, only the server token can
 * narrow itself to it, and a device credential never carries it.
 */
import { createMigratedDb } from './helpers/test-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const { WsHost } = await import('../../src/main/backend/ws-host')
const sessions = await import('../../src/main/backend/device-sessions')
const { setSetting } = await import('../../src/main/db/database')
const { FULL_SCOPES, PHONE_SCOPES, deviceSessionScopes, isChannelAllowed, narrowTokenScopes } =
  await import('../../src/shared/device-auth')
const { decodeFrame, BACKEND_CAPABILITIES } = await import('../../src/shared/ws-protocol')
const { AppChannels, HubRemoteChannels, ProjectCloneChannels, ProviderChannels, ProviderInstanceChannels } =
  await import('../../src/shared/ipc-channels')
const { PullRequestWriteChannels, TerminalChannels } = await import('../../src/shared/ipc-channels')
const { hubRemoteChildrenEnabled, HUB_REMOTE_CHILDREN_LABS_SETTING, HUB_CHILDREN_LABS_SETTING } =
  await import('../../src/shared/hub')
const {
  buildHubMachineDescription,
  cleanRemoteUrl,
  isHubAuthGrant,
  parseGitRemoteFetchUrls,
  HUB_DESCRIBE_MAX_PROJECTS,
} = await import('../../src/shared/hub-remote')

import type { DeviceScope } from '../../src/shared/device-auth'
import type { DeviceAuthPort } from '../../src/main/backend/ws-host'

const HUB_ONLY_DENIED = [
  TerminalChannels.CREATE,
  'terminal:write',
  'settings:get',
  'settings:set',
  ProviderInstanceChannels.LIST,
  ProviderInstanceChannels.UPSERT,
  AppChannels.GET_PROJECTS,
  AppChannels.DEVICE_SCOPES,
  ProviderChannels.SEND_TURN,
  ProviderChannels.START_SESSION,
  PullRequestWriteChannels.MERGE,
  PullRequestWriteChannels.REPLY,
  'mobile-pairing:devices',
  ProjectCloneChannels.CLONE,
  'files:write-file',
  'somethingNew:added-later',
]

describe('isChannelAllowed with the hub scope', () => {
  it('refuses a hub-only session everything outside hub-remote', () => {
    for (const channel of HUB_ONLY_DENIED) expect(isChannelAllowed(['hub'], channel), channel).toBe(false)
  })

  it('opens hub-remote to hub and to admin', () => {
    for (const scopes of [['hub'], FULL_SCOPES, ['admin']] as DeviceScope[][]) {
      expect(isChannelAllowed(scopes, HubRemoteChannels.DESCRIBE)).toBe(true)
      expect(isChannelAllowed(scopes, HubRemoteChannels.CHILDREN_CHANGED)).toBe(true)
    }
  })

  it('refuses hub-remote to every phone scope set', () => {
    for (const scopes of [['chat'], ['chat', 'terminal'], ['chat', 'pr-write'], PHONE_SCOPES] as DeviceScope[][]) {
      expect(isChannelAllowed(scopes, HubRemoteChannels.DESCRIBE), scopes.join(',')).toBe(false)
      expect(isChannelAllowed(scopes, HubRemoteChannels.OUTBOX), scopes.join(',')).toBe(false)
    }
  })

  it('keeps every existing scope set on chat, so none loses a channel', () => {
    expect(PHONE_SCOPES).toContain('chat')
    expect(FULL_SCOPES).toContain('chat')
    expect(FULL_SCOPES).not.toContain('hub')
    expect(PHONE_SCOPES).not.toContain('hub')
    expect(isChannelAllowed(PHONE_SCOPES, AppChannels.GET_PROJECTS)).toBe(true)
    expect(isChannelAllowed(['chat', 'pr-write'], PullRequestWriteChannels.REPLY)).toBe(true)
  })
})

describe('scope helpers', () => {
  it('gives a stored device session chat and never hub', () => {
    expect(deviceSessionScopes(['chat'])).toEqual(['chat'])
    expect(deviceSessionScopes(['pr-write'])).toEqual(['chat', 'pr-write'])
    expect(deviceSessionScopes(['chat', 'hub', 'bogus'])).toEqual(['chat'])
    expect(deviceSessionScopes([])).toEqual(['chat'])
  })

  it('narrows the server token to the asked scopes it holds, hub only through admin', () => {
    expect(narrowTokenScopes(['hub'], FULL_SCOPES)).toEqual(['hub'])
    expect(narrowTokenScopes(['hub', 'terminal'], FULL_SCOPES)).toEqual(['hub', 'terminal'])
    expect(narrowTokenScopes(['hub'], PHONE_SCOPES)).toEqual([])
    expect(narrowTokenScopes(['admin'], PHONE_SCOPES)).toEqual([])
  })

  it('decodes auth scopes and drops unknown names', () => {
    const frame = decodeFrame(JSON.stringify({ k: 'auth', session: 't', scopes: ['hub', 'root', 7] }))
    expect(frame).toEqual({ k: 'auth', session: 't', pairing: undefined, label: undefined, scopes: ['hub'] })
    const plain = decodeFrame(JSON.stringify({ k: 'auth', session: 't' }))
    expect(plain).not.toHaveProperty('scopes')
    const malformed = decodeFrame(JSON.stringify({ k: 'auth', session: 't', scopes: 'hub' }))
    expect(malformed).toMatchObject({ scopes: [] })
  })

  it('accepts exactly hub as the hub client grant', () => {
    expect(isHubAuthGrant(['hub'])).toBe(true)
    expect(isHubAuthGrant(['chat', 'terminal', 'admin'])).toBe(false)
    expect(isHubAuthGrant(['hub', 'chat'])).toBe(false)
    expect(isHubAuthGrant([])).toBe(false)
    expect(isHubAuthGrant(undefined)).toBe(false)
  })

  it('advertises hub_remote_child_v1', () => {
    expect(BACKEND_CAPABILITIES).toContain('hub_remote_child_v1')
  })
})

describe('hubRemoteChildrenEnabled', () => {
  const settings = (rows: Record<string, string>) => (key: string) => rows[key] ?? null

  it('is off by default and needs hub_children too', () => {
    expect(hubRemoteChildrenEnabled({}, settings({}))).toBe(false)
    expect(hubRemoteChildrenEnabled({ SB_HUB_REMOTE_CHILDREN: '1' }, settings({}))).toBe(false)
    expect(hubRemoteChildrenEnabled({}, settings({ [HUB_REMOTE_CHILDREN_LABS_SETTING]: 'true' }))).toBe(false)
  })

  it('turns on with the env or the labs setting while hub_children is on', () => {
    expect(hubRemoteChildrenEnabled({ SB_HUB_CHILDREN: '1', SB_HUB_REMOTE_CHILDREN: '1' }, settings({}))).toBe(true)
    expect(
      hubRemoteChildrenEnabled(
        {},
        settings({ [HUB_CHILDREN_LABS_SETTING]: 'true', [HUB_REMOTE_CHILDREN_LABS_SETTING]: 'true' }),
      ),
    ).toBe(true)
  })
})

describe('buildHubMachineDescription', () => {
  const base = {
    flagOn: false,
    os: 'linux',
    arch: 'x64',
    backendVersion: '1.2.3',
    availableAgents: ['claude-code', 'codex', 'opencode'] as const,
    instances: [
      { id: 'claude-code-default', agentType: 'claude-code' as const, displayName: 'Claude', enabled: true },
      { id: 'claude-work', agentType: 'claude-code' as const, displayName: 'Work', enabled: true },
      { id: 'claude-old', agentType: 'claude-code' as const, displayName: 'Old', enabled: false },
      { id: 'codex-default', agentType: 'codex' as const, displayName: 'Codex', enabled: false },
      { id: 'gemini-default', agentType: 'gemini' as const, displayName: 'Gemini', enabled: true },
    ],
    homeDir: '/home/u',
    projects: [],
    freeDiskBytes: 5_000,
    openChildren: 2,
    runningSlotKeys: ['claude-work', 'claude-code-default', 'claude-work'],
    runningPerInstance: 3,
  }

  it('lists only agents that run here with an enabled account, and their slots', () => {
    const d = buildHubMachineDescription({ ...base, availableAgents: [...base.availableAgents] })
    expect(d.v).toBe(1)
    expect(d.flagOn).toBe(false)
    expect(d.agents.map((a) => a.agent)).toEqual(['claude-code'])
    expect(d.agents[0].accounts).toEqual([
      { instanceId: 'claude-code-default', name: 'Claude' },
      { instanceId: 'claude-work', name: 'Work' },
    ])
    expect(d.agents[0].models.length).toBeGreaterThan(0)
    expect(d.runSlots).toEqual([
      { instanceId: 'claude-code-default', running: 1, limit: 3 },
      { instanceId: 'claude-work', running: 2, limit: 3 },
    ])
    expect(d.openChildren).toBe(2)
    expect(d.freeDiskBytes).toBe(5_000)
    expect(Object.keys(d).sort()).toEqual(
      [
        'v',
        'flagOn',
        'os',
        'arch',
        'backendVersion',
        'agents',
        'projects',
        'freeDiskBytes',
        'openChildren',
        'runSlots',
      ].sort(),
    )
  })

  it('caps projects, dedupes remote URLs and strips credentials', () => {
    const projects = Array.from({ length: HUB_DESCRIBE_MAX_PROJECTS + 5 }, (_, i) => ({
      path: `/home/u/p${i}`,
      branch: i === 0 ? null : 'main',
      remoteUrls: [
        'https://x:secret@example.com/a.git',
        'https://example.com/a.git',
        'HTTPS://ghp_token@example.com/b.git',
        'git@example.com:a.git',
      ],
    }))
    const d = buildHubMachineDescription({ ...base, availableAgents: [], projects })
    expect(d.projects).toHaveLength(HUB_DESCRIBE_MAX_PROJECTS)
    expect(d.projects[0]).toEqual({
      path: '~/p0',
      branch: null,
      remoteUrls: ['https://example.com/a.git', 'HTTPS://example.com/b.git', 'example.com:a.git'],
    })
  })

  it('sends paths from home and leaves out another user home', () => {
    const projects = ['/home/u', '/home/u/a/b', '/home/other/x', '/Users/someone/y', '/srv/app', '/home/uu/z'].map(
      (path) => ({ path, branch: 'main', remoteUrls: [] }),
    )
    const d = buildHubMachineDescription({ ...base, availableAgents: [], projects })
    expect(d.projects.map((p) => p.path)).toEqual(['~', '~/a/b', '/srv/app'])
    const win = buildHubMachineDescription({
      ...base,
      homeDir: 'C:\\Users\\u',
      availableAgents: [],
      projects: ['C:\\Users\\u\\proj', 'C:\\Users\\alice\\x', 'D:\\work\\y'].map((path) => ({
        path,
        branch: null,
        remoteUrls: [],
      })),
    })
    expect(win.projects.map((p) => p.path)).toEqual(['~/proj', 'D:\\work\\y'])
  })

  it('strips the user part from every remote form and drops local remotes', () => {
    expect(cleanRemoteUrl('ssh://tejas@vm.internal/r.git')).toBe('ssh://vm.internal/r.git')
    expect(cleanRemoteUrl('ssh://git@github.com:22/o/r.git')).toBe('ssh://github.com:22/o/r.git')
    expect(cleanRemoteUrl('tejas@vm.internal:r.git')).toBe('vm.internal:r.git')
    expect(cleanRemoteUrl('github.com:o/r.git')).toBe('github.com:o/r.git')
    expect(cleanRemoteUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git')
    expect(cleanRemoteUrl('file:///home/u/r.git')).toBeNull()
    expect(cleanRemoteUrl('/home/u/r.git')).toBeNull()
    expect(cleanRemoteUrl('../r.git')).toBeNull()
    expect(cleanRemoteUrl('https://example.com/r.git?access_token=secret#x')).toBe('https://example.com/r.git')
    expect(cleanRemoteUrl('C:\\Users\\alice\\repo')).toBeNull()
    expect(cleanRemoteUrl('C:/Users/alice/repo')).toBeNull()
  })

  it('reads fetch URLs from git remote -v', () => {
    const out = [
      'origin\tgit@example.com:o/r.git (fetch)',
      'origin\tgit@example.com:o/r.git (push)',
      'fork\thttps://example.com/me/r.git (fetch)',
      'mirror\tgit@example.com:o/r.git (fetch)',
      '',
    ].join('\n')
    expect(parseGitRemoteFetchUrls(out)).toEqual(['git@example.com:o/r.git', 'https://example.com/me/r.git'])
  })
})

// ─── WsHost round trip ──────────────────────────────────────────

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

async function boot(
  token: string | undefined,
  deviceAuth?: DeviceAuthPort,
): Promise<{ host: InstanceType<typeof WsHost>; port: number }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const host = new WsHost(wss, token, deviceAuth, deviceAuth !== undefined)
  cleanups.push(() => {
    host.dispose()
    wss.close()
  })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  return { host, port: (wss.address() as AddressInfo).port }
}

async function client(port: number): Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?auth=frame`)
  cleanups.push(() => ws.close())
  const queue: Array<Record<string, unknown>> = []
  const waiters: Array<(v: Record<string, unknown>) => void> = []
  ws.on('message', (data) => {
    const value = JSON.parse(String(data)) as Record<string, unknown>
    if (value.k === 'ping') return
    const waiter = waiters.shift()
    if (waiter) waiter(value)
    else queue.push(value)
  })
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  const next = (): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const value = queue.shift()
      if (value) resolve(value)
      else waiters.push(resolve)
    })
  return { ws, next }
}

describe('WsHost and the hub scope', () => {
  it('narrows the server token to hub: hub-remote answers, nothing else does', async () => {
    const { host, port } = await boot('s3cret')
    host.handle(HubRemoteChannels.DESCRIBE, () => ({ v: 1 }))
    host.handle(AppChannels.GET_PROJECTS, () => [])
    const { ws, next } = await client(port)

    ws.send(JSON.stringify({ k: 'auth', session: 's3cret', scopes: ['hub'] }))
    expect(await next()).toEqual({ k: 'authed', ok: true, scopes: ['hub'] })

    ws.send(JSON.stringify({ k: 'req', id: 1, ch: AppChannels.GET_PROJECTS, args: [] }))
    expect(await next()).toMatchObject({
      k: 'res',
      id: 1,
      ok: false,
      error: `not permitted: ${AppChannels.GET_PROJECTS}`,
    })
    ws.send(JSON.stringify({ k: 'req', id: 2, ch: HubRemoteChannels.DESCRIBE, args: [] }))
    expect(await next()).toEqual({ k: 'res', id: 2, ok: true, result: { v: 1 } })

    host.emit(HubRemoteChannels.OUTBOX)
    expect(await next()).toMatchObject({ k: 'evt', ch: HubRemoteChannels.OUTBOX, seq: 1 })
    host.emit('provider:event', { secret: true })
    host.emit(HubRemoteChannels.CHILDREN_CHANGED, 'x')
    expect(await next()).toMatchObject({ k: 'evt', ch: HubRemoteChannels.CHILDREN_CHANGED, args: ['x'] })

    // A resume replays only what the live filter lets through.
    ws.send(JSON.stringify({ k: 'hello', since: 1, epoch: host.epoch }))
    expect(await next()).toMatchObject({ k: 'evt', ch: HubRemoteChannels.CHILDREN_CHANGED })
    expect(await next()).toMatchObject({ k: 'ready', replayed: 1 })
  })

  it('keeps the full set for the server token without scopes', async () => {
    const { port } = await boot('s3cret')
    const { ws, next } = await client(port)
    ws.send(JSON.stringify({ k: 'auth', session: 's3cret' }))
    expect(await next()).toEqual({ k: 'authed', ok: true, scopes: [...FULL_SCOPES] })
  })

  it('refuses a narrowing to scopes the token does not hold', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    const host = new WsHost(wss, 's3cret', undefined, false, PHONE_SCOPES)
    cleanups.push(() => {
      host.dispose()
      wss.close()
    })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    const { ws, next } = await client((wss.address() as AddressInfo).port)
    ws.send(JSON.stringify({ k: 'auth', session: 's3cret', scopes: ['hub'] }))
    expect(await next()).toMatchObject({ k: 'authed', ok: false })
  })

  it('gives a device session its own scopes whatever it asks for, and a pairing too', async () => {
    const { port } = await boot(undefined, {
      redeem: () => ({ ok: true, session: 'minted', scopes: ['chat'] }),
      authenticate: (session) =>
        session === 'phone' || session === 'minted' ? { id: 'phone-1', scopes: ['chat', 'hub'] } : null,
    })
    const phone = await client(port)
    phone.ws.send(JSON.stringify({ k: 'auth', session: 'phone', scopes: ['hub'] }))
    expect(await phone.next()).toEqual({ k: 'authed', ok: true, scopes: ['chat'] })

    const pairing = await client(port)
    pairing.ws.send(JSON.stringify({ k: 'auth', pairing: 'code', label: 'p', scopes: ['hub', 'admin'] }))
    expect(await pairing.next()).toEqual({ k: 'authed', ok: true, session: 'minted', scopes: ['chat'] })
  })
})

describe('stored device sessions', () => {
  beforeEach(() => {
    createMigratedDb()
  })

  it('keep chat when a row lacks it, and never hold hub', () => {
    const now = Date.now()
    setSetting(
      'deviceSessions',
      JSON.stringify([
        {
          id: 'd1',
          tokenHash: sessions.hashToken('tok'),
          label: 'old phone',
          scopes: ['hub', 'pr-write'],
          createdAt: now,
          lastSeenAt: now,
        },
      ]),
    )
    expect(sessions.authenticateSession('tok', {}, now)?.scopes).toEqual(['chat', 'pr-write'])
  })

  it('never pair with hub', () => {
    const { code } = sessions.createPairingCode()
    const result = sessions.redeemPairingCode(code, 'p', ['chat', 'hub'])
    expect(result.scopes).toEqual(['chat'])
  })
})

describe('describeThisMachine', () => {
  beforeEach(() => {
    createMigratedDb()
  })

  it('reads branch and remotes per project and survives a folder that is not a repository', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { platform, tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    const { addProject } = await import('../../src/main/db/database')
    const { describeThisMachine } = await import('../../src/main/hub/hub-remote-describe')
    const root = mkdtempSync(join(tmpdir(), 'sb-hub-describe-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const repo = join(root, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'trunk', repo])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.com/o/r.git'])
    addProject(repo, 'repo')
    addProject(join(root, 'missing'), 'missing')

    const d = await describeThisMachine({
      backendVersion: () => '9.9.9',
      agentAvailable: async (agent) => agent === 'claude-code',
      runningSlotKeys: () => [],
    })
    expect(d.backendVersion).toBe('9.9.9')
    expect(d.flagOn).toBe(false)
    expect(d.agents.map((a) => a.agent)).toEqual(['claude-code'])
    expect(d.openChildren).toBe(0)
    // The Windows temp folder is under C:\Users with a short name the home
    // path does not match, so it reads as another user's home and is left
    // out. The path rules have their own tests above.
    if (platform() === 'win32') return
    const byPath = new Map(d.projects.map((p) => [p.path, p]))
    expect(byPath.get(repo)).toEqual({ path: repo, branch: 'trunk', remoteUrls: ['https://example.com/o/r.git'] })
    expect(byPath.get(join(root, 'missing'))).toEqual({ path: join(root, 'missing'), branch: null, remoteUrls: [] })
  })

  it('shares one describe between calls that overlap', async () => {
    const { registerHubRemoteHandlers } = await import('../../src/main/hub/hub-remote-describe')
    const handlers = new Map<string, () => Promise<unknown>>()
    const host = { handle: (ch: string, fn: () => Promise<unknown>) => handlers.set(ch, fn) }
    let checks = 0
    registerHubRemoteHandlers(host as never, {
      backendVersion: () => '1',
      agentAvailable: async () => {
        checks++
        return false
      },
      runningSlotKeys: () => [],
    })
    const describe = handlers.get(HubRemoteChannels.DESCRIBE)!
    const [a, b] = [describe(), describe()]
    expect(a).toBe(b)
    await a
    const perCall = checks
    await describe()
    expect(checks).toBe(perCall * 2)
  })
})
