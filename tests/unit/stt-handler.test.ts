/**
 * SttChannels.TRANSCRIBE handler (src/main/ipc/stt.ts) against a fake host and
 * injected deps: payload validation, the 25 MB cap, lazy boot with retry after
 * failure, the multipart contract whisper-server expects, and status pushes.
 */
import { describe, it, expect, vi } from 'vitest'
import type { BackendHost } from '../../src/main/backend/host'
import { registerSttHandlers, type SttDeps } from '../../src/main/ipc/stt'
import { SttChannels } from '../../src/shared/ipc-channels'
import { MAX_STT_AUDIO_BYTES, type SttTranscribeRequest, type SttTranscribeResult } from '../../src/shared/stt'
import type { WhisperServerManager } from '../../src/main/stt/whisper-manager'

class FakeHost implements BackendHost {
  handlers = new Map<string, (...args: unknown[]) => unknown>()
  events: Array<{ channel: string; args: unknown[] }> = []
  handle<A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    this.handlers.set(channel, fn as (...args: unknown[]) => unknown)
  }
  on(): void {}
  emit(channel: string, ...args: unknown[]): void {
    this.events.push({ channel, args })
  }
}

function setup(overrides: Partial<SttDeps> = {}) {
  const host = new FakeHost()
  const manager = {
    status: 'stopped',
    ensureStarted: vi.fn(async () => {
      manager.status = 'ready'
      return 8123
    }),
    touch: vi.fn(),
    stop: vi.fn(),
  }
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ text: '  corrected text  ' }), { status: 200 }),
  )
  const deps: Partial<SttDeps> = {
    userDataRoot: () => '/tmp/sb-stt-test',
    ensureBinary: vi.fn(async () => '/bin/whisper-server'),
    ensureModel: vi.fn(async () => '/models/ggml.bin'),
    createManager: () => manager as unknown as WhisperServerManager,
    listProjectFiles: vi.fn(async () => ['src/main/stt/whisper-binary.ts', 'apps/mobile/src/lib/voice.ts']),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  }
  registerSttHandlers(host, deps)
  const transcribe = (req: unknown): Promise<SttTranscribeResult> =>
    host.handlers.get(SttChannels.TRANSCRIBE)!(req) as Promise<SttTranscribeResult>
  return { host, manager, fetchImpl, deps, transcribe }
}

const request = (over: Partial<SttTranscribeRequest> = {}): SttTranscribeRequest => ({
  audioBase64: Buffer.from('RIFF-fake-wav-bytes').toString('base64'),
  mimeType: 'audio/wav',
  projectPath: '/repo',
  durationMs: 4000,
  ...over,
})

describe('stt transcribe handler', () => {
  it('rejects a missing or empty payload without booting anything', async () => {
    const { transcribe, deps } = setup()
    expect(await transcribe(undefined)).toEqual({ ok: false, error: 'no audio payload' })
    expect(await transcribe(request({ audioBase64: '' }))).toEqual({
      ok: false,
      error: 'no audio payload',
    })
    expect(deps.ensureBinary).not.toHaveBeenCalled()
  })

  it('rejects audio over the byte cap before decoding it', async () => {
    const { transcribe, deps } = setup()
    const oversize = 'A'.repeat(Math.ceil((MAX_STT_AUDIO_BYTES + 1024) * (4 / 3)))
    const result = await transcribe(request({ audioBase64: oversize }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('byte cap')
    expect(deps.ensureBinary).not.toHaveBeenCalled()
  })

  it('serves the whisper-server multipart contract and trims the answer', async () => {
    const { transcribe, manager, fetchImpl } = setup()
    const result = await transcribe(request())
    expect(result).toEqual({
      ok: true,
      text: 'corrected text',
      provider: 'whisper',
      modelId: 'ggml-large-v3-turbo-q5_0.bin',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: FormData }]
    expect(url).toBe('http://127.0.0.1:8123/inference')
    const form = init.body
    expect(form.get('response_format')).toBe('json')
    expect(form.get('temperature')).toBe('0.0')
    expect(String(form.get('prompt'))).toContain('whisper-binary.ts')
    const file = form.get('file') as File
    expect(file.name).toBe('audio.wav')
    expect(manager.touch).toHaveBeenCalled()
  })

  it('omits the prompt when the project has no usable vocabulary', async () => {
    const { transcribe, fetchImpl } = setup({ listProjectFiles: vi.fn(async () => []) })
    await transcribe(request())
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: FormData }]
    expect(init.body.get('prompt')).toBeNull()
  })

  it('still transcribes when the file listing fails', async () => {
    const { transcribe } = setup({
      listProjectFiles: vi.fn(async () => {
        throw new Error('not a repo')
      }),
    })
    const result = await transcribe(request())
    expect(result.ok).toBe(true)
  })

  it('answers a clean error when no binary resolves, then recovers on retry', async () => {
    let attempts = 0
    const ensureBinary: SttDeps['ensureBinary'] = vi.fn(async () =>
      attempts++ === 0 ? null : '/bin/whisper-server',
    )
    const { transcribe, host } = setup({ ensureBinary })
    const first = await transcribe(request())
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.error).toContain('not installed')
    expect(host.events.some((e) => e.channel === SttChannels.STATUS)).toBe(true)
    // The failed boot must not wedge the handler: the next call boots afresh.
    const second = await transcribe(request())
    expect(second.ok).toBe(true)
  })

  it('surfaces a whisper-server HTTP failure as ok:false plus an error status', async () => {
    const { transcribe, host } = setup({
      fetchImpl: vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    })
    const result = await transcribe(request())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('500')
    const statuses = host.events
      .filter((e) => e.channel === SttChannels.STATUS)
      .map((e) => (e.args[0] as { status: string }).status)
    expect(statuses).toContain('error')
  })

  it('pushes starting and ready around a cold boot', async () => {
    const { transcribe, host } = setup()
    await transcribe(request())
    const statuses = host.events
      .filter((e) => e.channel === SttChannels.STATUS)
      .map((e) => (e.args[0] as { status: string }).status)
    expect(statuses).toEqual(expect.arrayContaining(['starting', 'ready']))
  })
})
