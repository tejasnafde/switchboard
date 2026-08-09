/**
 * whisper.cpp bootstrap (src/main/stt/whisper-binary.ts): release-asset
 * resolution per platform, the Linux shared-library env overlay, and the
 * atomic temp-then-rename model download.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureWhisperModel,
  resolveWhisperAsset,
  whisperModelPath,
  whisperModelUrl,
  whisperSpawnEnv,
  WHISPER_VERSION,
} from '../../src/main/stt/whisper-binary'

describe('resolveWhisperAsset', () => {
  it('resolves the Linux tarballs with their inner server path', () => {
    const asset = resolveWhisperAsset('v1.9.2', 'linux', 'x64')
    expect(asset).toEqual({
      assetName: 'whisper-bin-ubuntu-x64.tar.gz',
      serverRelPath: 'whisper-bin-ubuntu-x64/whisper-server',
      url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-ubuntu-x64.tar.gz',
    })
    expect(resolveWhisperAsset('v1.9.2', 'linux', 'arm64')?.serverRelPath).toBe(
      'whisper-bin-ubuntu-arm64/whisper-server',
    )
  })

  it('resolves the Windows x64 zip with the Release/ server path', () => {
    const asset = resolveWhisperAsset(WHISPER_VERSION, 'win32', 'x64')
    expect(asset?.assetName).toBe('whisper-bin-x64.zip')
    expect(asset?.serverRelPath).toBe(join('Release', 'whisper-server.exe'))
  })

  it('returns null where upstream ships no server binary', () => {
    expect(resolveWhisperAsset('v1.9.2', 'darwin', 'arm64')).toBeNull()
    expect(resolveWhisperAsset('v1.9.2', 'darwin', 'x64')).toBeNull()
    expect(resolveWhisperAsset('v1.9.2', 'win32', 'arm64')).toBeNull()
  })
})

describe('whisperModelUrl', () => {
  it('points at the ggerganov HF repo (the ggml-org mirror 401s anonymously)', () => {
    expect(whisperModelUrl('ggml-large-v3-turbo-q5_0.bin')).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    )
  })
})

describe('whisperSpawnEnv', () => {
  it('prepends the binary dir to LD_LIBRARY_PATH on linux', () => {
    const env = whisperSpawnEnv('/data/whisper/v1/bin/whisper-server', 'linux', {
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/opt/lib',
    })
    expect(env.LD_LIBRARY_PATH).toBe('/data/whisper/v1/bin:/opt/lib')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('sets LD_LIBRARY_PATH when none exists', () => {
    const env = whisperSpawnEnv('/data/whisper/v1/bin/whisper-server', 'linux', {})
    expect(env.LD_LIBRARY_PATH).toBe('/data/whisper/v1/bin')
  })

  it('leaves the env alone off linux', () => {
    const base = { PATH: '/usr/bin' }
    const env = whisperSpawnEnv('/usr/local/bin/whisper-server', 'darwin', base)
    expect(env).toEqual(base)
    expect(env).not.toBe(base) // copy, not the caller's object
  })
})

describe('ensureWhisperModel', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-whisper-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('downloads to a temp file and renames into place', async () => {
    const payload = 'ggml-bytes'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(payload, { headers: { 'content-length': String(payload.length) } }),
      ),
    )
    const seen: Array<number | null> = []
    const path = await ensureWhisperModel(root, 'ggml-test.bin', (pct) => seen.push(pct))
    expect(path).toBe(whisperModelPath(root, 'ggml-test.bin'))
    expect(readFileSync(path, 'utf8')).toBe(payload)
    // No .download-* temp left behind.
    expect(readdirSync(join(root, 'whisper', 'models'))).toEqual(['ggml-test.bin'])
    expect(seen[0]).toBeNull() // indeterminate marker before the first byte
    expect(seen).toContain(100)
  })

  it('skips the download when the model already exists', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const path = whisperModelPath(root, 'ggml-test.bin')
    mkdirSync(join(root, 'whisper', 'models'), { recursive: true })
    writeFileSync(path, 'cached')
    await expect(ensureWhisperModel(root, 'ggml-test.bin')).resolves.toBe(path)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('propagates HTTP failure and leaves no partial file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(ensureWhisperModel(root, 'ggml-test.bin')).rejects.toThrow('HTTP 404')
    expect(readdirSync(join(root, 'whisper', 'models'))).toEqual([])
  })
})
