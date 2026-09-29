/**
 * OpenCode 2.x is refused before anything is spawned against it: the chat
 * adapter, the `opencode models` catalog probe and the Settings Test. The
 * native-fork runner's refusal is in native-fork-runners.test.ts. Every
 * binary here is a fake script that records its arguments; no real opencode
 * runs.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ bin: null as string | null, warn: [] as unknown[][] }))

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
  createMainLogger: () => ({ info: vi.fn(), warn: (...args: unknown[]) => { state.warn.push(args) }, debug: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../src/main/provider/usage', () => ({ fetchInstanceUsage: vi.fn(), invalidateUsage: vi.fn() }))

import {
  OpencodeUnsupportedVersionError,
  _resetOpencodeVersionCacheForTests,
  assertSupportedOpencode,
  parseOpencodeVersion,
  opencodeEnvFingerprint,
  opencodeV2InstallSignal,
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
  state.warn = []
})
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sb-opencode-version-')))
  dirs.push(dir)
  return dir
}

/** A fake opencode that logs each invocation's arguments, one line per run. */
function fakeOpencode(
  versionOutput: string,
  { versionExit = 0, dir = scratch(), logCwd = false } = {},
): { bin: string; calls: () => string[] } {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'opencode')
  const log = join(dir, 'calls')
  writeFileSync(bin, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + (${logCwd} ? ' @' + process.cwd() : '') + '\\n')
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
    await expect(readOpencodeVersion('/nonexistent/opencode', {}, undefined, run)).resolves.toBeNull()
  })

  itWithPosixToolShims('logs only the size of output it cannot parse, never its text', async () => {
    const fake = fakeOpencode('OPENAI_API_KEY=sk-secret-value\n')
    await expect(readOpencodeVersion(fake.bin, {})).resolves.toBeNull()
    expect(JSON.stringify(state.warn)).not.toContain('sk-secret')
    expect(state.warn.some(([, detail]) => (detail as { bytes?: number })?.bytes === 31)).toBe(true)
  })

  itWithPosixToolShims('runs --version in the session cwd, and caches per cwd', async () => {
    const fake = fakeOpencode('1.18.33\n', { logCwd: true })
    const a = scratch()
    const b = scratch()
    await readOpencodeVersion(fake.bin, {}, a)
    await readOpencodeVersion(fake.bin, {}, a)
    await readOpencodeVersion(fake.bin, {}, b)
    expect(fake.calls()).toEqual([`--version @${a}`, `--version @${b}`])
  })

  it('fingerprints only the env that can pick a binary, in any order', () => {
    const base = { PATH: '/usr/bin', OPENCODE_CONFIG_DIR: '/a' }
    expect(opencodeEnvFingerprint(base)).toBe(opencodeEnvFingerprint({ OPENCODE_CONFIG_DIR: '/a', PATH: '/usr/bin' }))
    expect(opencodeEnvFingerprint(base)).toBe(opencodeEnvFingerprint({ ...base, OPENAI_API_KEY: 'sk-1' }))
    expect(opencodeEnvFingerprint(base)).not.toBe(opencodeEnvFingerprint({ ...base, PATH: '/opt/v2/bin:/usr/bin' }))
    expect(opencodeEnvFingerprint(base)).not.toBe(opencodeEnvFingerprint({ ...base, OPENCODE_CONFIG_DIR: '/b' }))
    expect(opencodeEnvFingerprint(base)).not.toContain('/usr/bin')
  })

  itWithPosixToolShims('does not share a cached answer between envs that can pick different binaries', async () => {
    const fake = fakeOpencode('1.18.33\n')
    const one = { PATH: process.env.PATH ?? '', OPENCODE_INSTALL: 'one' }
    await readOpencodeVersion(fake.bin, one)
    await readOpencodeVersion(fake.bin, { ...one, GEMINI_API_KEY: 'k' })
    expect(fake.calls()).toEqual(['--version'])
    await readOpencodeVersion(fake.bin, { ...one, OPENCODE_INSTALL: 'two' })
    expect(fake.calls()).toEqual(['--version', '--version'])
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

describe('a 2.x install whose --version gives no answer', () => {
  itWithPosixToolShims('is refused when an opencode2 shim sits beside it (v2 curl installer, @opencode/cli bin)', async () => {
    const fake = fakeOpencode('', { versionExit: 1 })
    writeFileSync(join(fake.bin, '..', 'opencode2'), '#!/bin/sh\n')
    const failure = await assertSupportedOpencode(fake.bin, {}).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OpencodeUnsupportedVersionError)
    expect((failure as Error).message).toContain('OpenCode 2.x is not supported yet')
  })

  itWithPosixToolShims('is refused when it resolves into the @opencode/cli package', async () => {
    const root = scratch()
    const fake = fakeOpencode('garbage', { dir: join(root, 'lib', 'node_modules', '@opencode', 'cli', 'bin') })
    mkdirSync(join(root, 'bin'))
    const link = join(root, 'bin', 'opencode')
    symlinkSync(fake.bin, link)
    expect(opencodeV2InstallSignal(link)).toBe('installed from the @opencode/cli package')
    await expect(assertSupportedOpencode(link, {})).rejects.toBeInstanceOf(OpencodeUnsupportedVersionError)
  })

  it('is recognised from the opencode-v2 Homebrew formula path', () => {
    const root = scratch()
    const dir = join(root, 'Cellar', 'opencode-v2', '2.0.19', 'bin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode'), '')
    expect(opencodeV2InstallSignal(join(dir, 'opencode'))).toBe('installed from the opencode-v2 Homebrew formula')
  })

  itWithPosixToolShims('is let through with no signal, since a 1.x may simply fail --version', async () => {
    const fake = fakeOpencode('', { versionExit: 1 })
    expect(opencodeV2InstallSignal(fake.bin)).toBeNull()
    await expect(assertSupportedOpencode(fake.bin, {})).resolves.toBeUndefined()
  })

  itWithPosixToolShims('does not override a readable 1.x version', async () => {
    const fake = fakeOpencode('1.18.33\n')
    writeFileSync(join(fake.bin, '..', 'opencode2'), '#!/bin/sh\n')
    await expect(assertSupportedOpencode(fake.bin, {})).resolves.toBeUndefined()
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
