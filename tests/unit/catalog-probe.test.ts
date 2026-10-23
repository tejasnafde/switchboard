import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const execFile = vi.fn()
const resolveProviderInstance = vi.fn()

const dataDir = mkdtempSync(join(tmpdir(), 'sb-catalog-'))
const cacheFile = join(dataDir, 'data', 'model-catalog.json')
vi.mock('../../src/main/runtime', () => ({ userDataDir: () => dataDir }))
vi.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFile(...args) }))
vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (...args: unknown[]) => resolveProviderInstance(...args),
}))
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../src/main/provider/adapters/claude-adapter', () => ({
  findClaudeBin: () => undefined,
  buildClaudeCliEnv: () => ({}),
}))
vi.mock('../../src/main/provider/adapters/codex-adapter', () => ({
  findCodexPath: () => '/bin/codex',
  parseCodexModels: (r: { data: Array<{ id: string }> }) =>
    r.data.map((m) => ({ id: m.id, label: m.id, tier: 'balanced' })),
  buildCodexCliEnv: () => ({}),
}))
const applyCredentialHome = vi.fn((env: Record<string, string>, _agent: string, dir: string) => {
  env.CODEX_HOME = dir
})
vi.mock('../../src/main/provider/credential-home', () => ({
  applyCredentialHome: (...a: [Record<string, string>, string, string]) => applyCredentialHome(...a),
}))
vi.mock('../../src/main/provider/remote-gate', () => ({
  remoteProviderConfigDir: (_agent: string, seg: string) => `/home/vm/${seg}`,
}))
vi.mock('../../src/main/provider/adapters/opencode/env', () => ({
  findOpencodePath: () => '/bin/opencode',
  buildOpencodeEnv: () => ({}),
}))
vi.mock('../../src/main/provider/adapters/opencode/version', () => ({ assertSupportedOpencode: async () => {} }))
vi.mock('../../src/main/provider/instance-env', () => ({ resolveInstanceEnv: () => ({}) }))
const codexEnvs: Array<Record<string, string>> = []
vi.mock('../../src/main/provider/usage/codex-usage', () => ({
  CodexProbeSession: class {
    constructor(_bin: string, env: Record<string, string>) {
      codexEnvs.push(env)
    }
    send(method: string) {
      return Promise.resolve(method === 'model/list' ? { data: [{ id: 'gpt-6-sol' }] } : {})
    }
    notify() {}
    dispose() {}
  },
}))

const { probeCatalog, peekCatalog, invalidateCatalog } = await import('../../src/main/provider/catalog-probe')

function answer(stdout: string) {
  execFile.mockImplementationOnce(
    (_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, stdout),
  )
}

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

beforeEach(() => {
  execFile.mockReset()
  resolveProviderInstance.mockReset()
  resolveProviderInstance.mockReturnValue({ id: 'opencode-default', env: {} })
  invalidateCatalog()
})

describe('probeCatalog', () => {
  it('turns `opencode models` output into labelled, tiered rows and skips non-id lines', async () => {
    answer('Loading...\ngoogle/gemini-2.5-pro\nnvidia-nim/z-ai/glm-5.1\n\n')
    const models = await probeCatalog('opencode', undefined)
    expect(models.map((m) => m.id)).toEqual(['google/gemini-2.5-pro', 'nvidia-nim/z-ai/glm-5.1'])
    expect(models[0].tier).toBe('max')
  })

  it('caches per instance, so a second ask does not spawn again', async () => {
    answer('google/gemini-2.5-flash\n')
    await probeCatalog('opencode', undefined)
    await probeCatalog('opencode', undefined)
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('does not cache an empty answer, so the next ask retries', async () => {
    answer('')
    answer('google/gemini-2.5-flash\n')
    expect(await probeCatalog('opencode', undefined)).toEqual([])
    expect((await probeCatalog('opencode', undefined)).length).toBe(1)
  })

  it('falls back to the default instance for an id this backend does not know', async () => {
    resolveProviderInstance.mockImplementationOnce(() => {
      throw new Error('Provider instance not found: desktop-only')
    })
    answer('google/gemini-2.5-flash\n')
    expect((await probeCatalog('opencode', 'desktop-only')).length).toBe(1)
    expect(resolveProviderInstance).toHaveBeenLastCalledWith('opencode', null)
  })

  it('returns [] instead of throwing when the probe fails', async () => {
    execFile.mockImplementationOnce((_b: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
      cb(new Error('boom')),
    )
    expect(await probeCatalog('opencode', undefined)).toEqual([])
  })

  it('peekCatalog answers only from the cache and never spawns', async () => {
    expect(peekCatalog('opencode', undefined)).toBeUndefined()
    expect(execFile).not.toHaveBeenCalled()
    answer('google/gemini-2.5-flash\n')
    await probeCatalog('opencode', undefined)
    expect(peekCatalog('opencode', undefined)?.length).toBe(1)
  })

  it('probes a remote profile with its own config dir, not the default account', async () => {
    codexEnvs.length = 0
    const models = await probeCatalog('codex', 'desktop-profile', '.codex-work')
    expect(models.map((m) => m.id)).toEqual(['gpt-6-sol'])
    expect(codexEnvs[0].CODEX_HOME).toBe('/home/vm/.codex-work')
    expect(resolveProviderInstance).not.toHaveBeenCalled()
  })

  it('answers from the disk cache after a restart without spawning', async () => {
    answer('google/gemini-2.5-flash\n')
    await probeCatalog('opencode', undefined)
    vi.resetModules()
    const fresh = await import('../../src/main/provider/catalog-probe')
    expect((await fresh.probeCatalog('opencode', undefined)).map((m) => m.id)).toEqual(['google/gemini-2.5-flash'])
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('answers a stale catalog at once and refreshes it behind the reply', async () => {
    mkdirSync(join(dataDir, 'data'), { recursive: true })
    const old = { id: 'google/old', label: 'old', tier: 'balanced' }
    writeFileSync(cacheFile, JSON.stringify({ 'opencode:opencode-default': { models: [old], at: 0 } }))
    vi.resetModules()
    const fresh = await import('../../src/main/provider/catalog-probe')
    answer('google/new\n')
    expect((await fresh.probeCatalog('opencode', undefined)).map((m) => m.id)).toEqual(['google/old'])
    await vi.waitFor(() => expect(fresh.peekCatalog('opencode', undefined)?.[0].id).toBe('google/new'))
    expect(readFileSync(cacheFile, 'utf8')).toContain('google/new')
    fresh.invalidateCatalog()
  })

  it('drops a stale catalog when its refresh finds no models', async () => {
    mkdirSync(join(dataDir, 'data'), { recursive: true })
    const old = { id: 'google/old', label: 'old', tier: 'balanced' }
    writeFileSync(cacheFile, JSON.stringify({ 'opencode:opencode-default': { models: [old], at: 0 } }))
    vi.resetModules()
    const fresh = await import('../../src/main/provider/catalog-probe')
    answer('')
    expect((await fresh.probeCatalog('opencode', undefined)).map((m) => m.id)).toEqual(['google/old'])
    await vi.waitFor(() => expect(readFileSync(cacheFile, 'utf8')).toBe('{}'))
    fresh.invalidateCatalog()
  })

  it('invalidateCatalog forgets the disk cache too', async () => {
    answer('google/gemini-2.5-flash\n')
    await probeCatalog('opencode', undefined)
    expect(existsSync(cacheFile)).toBe(true)
    invalidateCatalog()
    expect(existsSync(cacheFile)).toBe(false)
  })
})
