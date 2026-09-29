/**
 * OpenCode 2.x is refused before anything is spawned against it: the chat
 * adapter, the `opencode models` catalog probe and the Settings Test. The
 * native-fork runner's refusal is in native-fork-runners.test.ts. Every
 * binary here is a fake script that records its arguments; no real opencode
 * runs.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ bin: null as string | null }))

vi.mock('../../src/main/provider/adapters/opencode/env', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/provider/adapters/opencode/env')>(),
  findOpencodePath: () => state.bin,
  buildOpencodeEnv: (overlay?: Record<string, string>) => ({ PATH: process.env.PATH ?? '', ...overlay }),
}))
vi.mock('../../src/main/db/provider-instances', () => ({
  listProviderInstances: vi.fn(() => []),
  resolveEffectiveOauthDir: vi.fn(() => null),
  upsertProviderInstance: vi.fn(),
  deleteProviderInstance: vi.fn(),
  getProviderInstanceFull: vi.fn(() => ({ id: 'oc', agentType: 'opencode', env: {} })),
  resolveProviderInstance: vi.fn(() => ({ id: 'oc', agentType: 'opencode', env: {} })),
}))
vi.mock('../../src/main/provider/instance-env', () => ({ resolveInstanceEnv: () => ({ PATH: process.env.PATH ?? '' }) }))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../src/main/provider/usage', () => ({ fetchInstanceUsage: vi.fn(), invalidateUsage: vi.fn() }))

import {
  OpencodeUnsupportedVersionError,
  _resetOpencodeVersionCacheForTests,
  assertSupportedOpencode,
  parseOpencodeVersion,
  readOpencodeVersion,
} from '../../src/main/provider/adapters/opencode/version'
import { opencodeCandidatePaths } from '../../src/main/provider/adapters/opencode/env'
import { invalidateCatalog, probeCatalog } from '../../src/main/provider/catalog-probe'
import { OpencodeAcpAdapter } from '../../src/main/provider/adapters/opencode-acp-adapter'
import { registerProviderInstanceHandlers } from '../../src/main/ipc/provider-instances'
import { ProviderInstanceChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'

// Executable-script shims cannot be spawned on Windows, as elsewhere in the suite.
const itWithPosixToolShims = process.platform === 'win32' ? it.skip : it

const dirs: string[] = []
beforeEach(() => {
  _resetOpencodeVersionCacheForTests()
  invalidateCatalog()
  state.bin = null
})
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A fake opencode that logs each invocation's arguments, one line per run. */
function fakeOpencode(versionOutput: string, { versionExit = 0 } = {}): { bin: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'sb-opencode-version-'))
  dirs.push(dir)
  const bin = join(dir, 'opencode')
  const log = join(dir, 'calls')
  writeFileSync(bin, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')
if (process.argv[2] === '--version') {
  process.stdout.write(${JSON.stringify(versionOutput)})
  process.exit(${versionExit})
}
if (process.argv[2] === 'models') {
  console.log('google/gemini-2.5-pro')
  process.exit(0)
}
process.exit(3)
`)
  chmodSync(bin, 0o755)
  return {
    bin,
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
  }
}

describe('parseOpencodeVersion', () => {
  it('reads a bare v1 and v2 version', () => {
    expect(parseOpencodeVersion('1.18.33\n')).toEqual({ raw: '1.18.33', major: 1 })
    expect(parseOpencodeVersion('2.0.19\n')).toEqual({ raw: '2.0.19', major: 2 })
  })

  it('reads a prefixed or tagged version', () => {
    expect(parseOpencodeVersion('opencode v2.0.19')).toEqual({ raw: '2.0.19', major: 2 })
    expect(parseOpencodeVersion('opencode 2.1.0-beta.3 (darwin-arm64)')).toEqual({ raw: '2.1.0-beta.3', major: 2 })
    expect(parseOpencodeVersion('Update available\n1.18.33\n')).toEqual({ raw: '1.18.33', major: 1 })
  })

  it('returns null for output with no version in it', () => {
    expect(parseOpencodeVersion('')).toBeNull()
    expect(parseOpencodeVersion('command not found: opencode')).toBeNull()
    expect(parseOpencodeVersion('error 12 occurred')).toBeNull()
    expect(parseOpencodeVersion('build abc1.2def')).toBeNull()
  })
})

describe('readOpencodeVersion', () => {
  itWithPosixToolShims('treats a failed run as unknown, never as v2, and retries it next time', async () => {
    const fake = fakeOpencode('2.0.19', { versionExit: 1 })
    await expect(readOpencodeVersion(fake.bin, {})).resolves.toBeNull()
    await expect(assertSupportedOpencode(fake.bin, {})).resolves.toBeUndefined()
    expect(fake.calls()).toEqual(['--version', '--version'])
  })

  it('treats a binary that cannot be run as unknown', async () => {
    await expect(assertSupportedOpencode('/nonexistent/opencode', {})).resolves.toBeUndefined()
  })

  it('treats unparseable output as unknown', async () => {
    const run = vi.fn(async () => 'garbage')
    await expect(readOpencodeVersion('/nonexistent/opencode', {}, run)).resolves.toBeNull()
  })

  itWithPosixToolShims('reads a binary once, and again after it is replaced in place', async () => {
    const fake = fakeOpencode('1.18.33')
    await readOpencodeVersion(fake.bin, {})
    await readOpencodeVersion(fake.bin, {})
    expect(fake.calls()).toEqual(['--version'])
    const later = new Date(Date.now() + 60_000)
    utimesSync(fake.bin, later, later)
    await readOpencodeVersion(fake.bin, {})
    expect(fake.calls()).toEqual(['--version', '--version'])
  })

  itWithPosixToolShims('refuses 2.x with copy that names the fix, and lets 1.x through', async () => {
    const v2 = fakeOpencode('2.0.19\n')
    const failure = await assertSupportedOpencode(v2.bin, {}).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OpencodeUnsupportedVersionError)
    expect((failure as Error).message).toContain('OpenCode 2.0.19 is not supported yet')
    expect((failure as Error).message).toContain('npm i -g opencode-ai')
    await expect(assertSupportedOpencode(fakeOpencode('1.18.33\n').bin, {})).resolves.toBeUndefined()
  })
})

describe('refusing OpenCode 2.x on every spawn path', () => {
  itWithPosixToolShims('the chat adapter refuses before spawning acp', async () => {
    const fake = fakeOpencode('2.0.19\n')
    state.bin = fake.bin
    const adapter = new OpencodeAcpAdapter()
    const onEvent = vi.fn()
    const failure = await adapter.startSession({
      threadId: 't-v2',
      provider: 'opencode',
      cwd: tmpdir(),
      runtimeMode: 'sandbox',
    }, onEvent).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OpencodeUnsupportedVersionError)
    expect(fake.calls()).toEqual(['--version'])
    expect(onEvent).not.toHaveBeenCalled()
  })

  itWithPosixToolShims('the catalog probe returns no models without running `opencode models`', async () => {
    const fake = fakeOpencode('2.0.19\n')
    state.bin = fake.bin
    await expect(probeCatalog('opencode', 'oc')).resolves.toEqual([])
    expect(fake.calls()).toEqual(['--version'])
  })

  itWithPosixToolShims('the catalog probe still lists a 1.x install', async () => {
    const fake = fakeOpencode('1.18.33\n')
    state.bin = fake.bin
    const models = await probeCatalog('opencode', 'oc')
    expect(models.map((m) => m.id)).toEqual(['google/gemini-2.5-pro'])
    expect(fake.calls()).toEqual(['--version', 'models'])
  })

  itWithPosixToolShims('the Settings Test shows the same copy as chat', async () => {
    const fake = fakeOpencode('2.0.19\n')
    state.bin = fake.bin
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const host = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) }, on() {}, emit() {} }
    registerProviderInstanceHandlers(host as unknown as BackendHost)
    const result = await handlers.get(ProviderInstanceChannels.TEST)!('oc') as { ok: boolean; message: string }
    expect(result.ok).toBe(false)
    expect(result.message).toBe(new OpencodeUnsupportedVersionError('2.0.19', fake.bin).message)
    expect(fake.calls()).toEqual(['--version'])
  })
})

describe('opencodeCandidatePaths', () => {
  it('probes the curl installers location, after the npm and brew ones', () => {
    const paths = opencodeCandidatePaths('/Users/me')
    expect(paths).toContain('/Users/me/.opencode/bin/opencode')
    expect(paths.at(-1)).toBe('/Users/me/.opencode/bin/opencode')
    expect(paths.indexOf('/opt/homebrew/bin/opencode')).toBeLessThan(paths.indexOf('/Users/me/.opencode/bin/opencode'))
  })
})
