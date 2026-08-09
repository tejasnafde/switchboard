/**
 * Backend speech-to-text IPC: composes the tested pieces (ensureWhisperBinary,
 * ensureWhisperModel, WhisperServerManager, buildSttPrompt) behind
 * SttChannels. One whisper-server per backend, lazy - nothing downloads or
 * spawns until the first TRANSCRIBE. Registered on both hosts, so a paired
 * phone reaches it over WS/TCP exactly like the files handlers.
 *
 * whisper-server HTTP contract (examples/server README, verified v1.9.2):
 * POST /inference, multipart form - `file` (audio), `prompt` (initial
 * prompt), `temperature`, `response_format=json`; answers `{ "text": ... }`.
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { BackendHost } from '../backend/host'
import { SttChannels } from '@shared/ipc-channels'
import {
  MAX_STT_AUDIO_BYTES,
  WHISPER_MODEL_NAME,
  base64DecodedBytes,
  buildSttPrompt,
  type SttStatusEvent,
  type SttTranscribeRequest,
  type SttTranscribeResult,
} from '@shared/stt'
import { ensureWhisperBinary, ensureWhisperModel, whisperSpawnEnv } from '../stt/whisper-binary'
import { WhisperServerManager } from '../stt/whisper-manager'
import { listAllFiles } from '../files/listing'
import { allocatePort } from '../machines/connectDeps'
import { userDataDir } from '../runtime'
import { createMainLogger } from '../logger'

const log = createMainLogger('ipc:stt')

/** Files fed to the vocabulary prompt - it caps at ~800 chars anyway. */
const PROMPT_FILE_CAP = 2000
const INFERENCE_TIMEOUT_MS = 120_000

export interface SttDeps {
  userDataRoot(): string
  ensureBinary(userDataRoot: string, onProgress?: (pct: number | null) => void): Promise<string | null>
  ensureModel(
    userDataRoot: string,
    modelName: string,
    onProgress?: (pct: number | null) => void,
  ): Promise<string>
  createManager(binaryPath: string, modelPath: string, onExit: () => void): WhisperServerManager
  listProjectFiles(projectPath: string): Promise<string[]>
  fetchImpl: typeof fetch
}

function defaultDeps(): SttDeps {
  return {
    userDataRoot: () => userDataDir(),
    ensureBinary: ensureWhisperBinary,
    ensureModel: ensureWhisperModel,
    createManager: (binaryPath, modelPath, onExit) =>
      new WhisperServerManager(
        {
          spawn: (bin, args, env) => {
            const child = spawn(bin, args, { env })
            child.stdout.on('data', (d) => log.debug(`whisper-server: ${String(d).trimEnd()}`))
            child.stderr.on('data', (d) => log.debug(`whisper-server err: ${String(d).trimEnd()}`))
            child.on('error', (err) => log.error('whisper-server spawn error', err))
            return child
          },
          allocatePort,
          probeHealth: async (url) => {
            try {
              // Any HTTP answer means the model is loaded and the port is
              // bound; the timeout guards a socket that accepts but hangs.
              await fetch(url, { signal: AbortSignal.timeout(1000) })
              return true
            } catch {
              return false
            }
          },
          delay: (ms) => delay(ms),
        },
        {
          binaryPath,
          modelPath,
          env: whisperSpawnEnv(binaryPath, process.platform, process.env),
          onExit,
        },
      ),
    listProjectFiles: (projectPath) => listAllFiles(projectPath, PROMPT_FILE_CAP),
    fetchImpl: fetch,
  }
}

export function registerSttHandlers(host: BackendHost, overrides?: Partial<SttDeps>): void {
  const deps: SttDeps = { ...defaultDeps(), ...overrides }

  interface Runtime {
    manager: WhisperServerManager
  }
  let runtime: Runtime | null = null
  let booting: Promise<Runtime> | null = null

  const pushStatus = (event: SttStatusEvent): void => {
    host.emit(SttChannels.STATUS, event)
  }

  async function boot(): Promise<Runtime> {
    const userDataRoot = deps.userDataRoot()
    const binaryPath = await deps.ensureBinary(userDataRoot, (pct) =>
      pushStatus({ status: 'downloading', pct: pct ?? undefined }),
    )
    if (!binaryPath) {
      throw new Error(
        'whisper-server is not installed and no prebuilt binary exists for this platform. ' +
          'Install it on the backend (e.g. `brew install whisper-cpp`) and retry.',
      )
    }
    const modelPath = await deps.ensureModel(userDataRoot, WHISPER_MODEL_NAME, (pct) =>
      pushStatus({ status: 'downloading', pct: pct ?? undefined }),
    )
    const manager = deps.createManager(binaryPath, modelPath, () => pushStatus({ status: 'stopped' }))
    return { manager }
  }

  async function vocabularyPrompt(projectPath: string): Promise<string> {
    if (!projectPath) return ''
    try {
      return buildSttPrompt(await deps.listProjectFiles(projectPath))
    } catch (err) {
      // A missing project must not fail the transcription - it only loses bias.
      log.warn('vocabulary prompt build failed', { projectPath, err: (err as Error).message })
      return ''
    }
  }

  // Runs in Electron main and in the headless server alike; 'exit' covers
  // both, so a quit never orphans the whisper child.
  process.once('exit', () => runtime?.manager.stop())

  host.handle<[SttTranscribeRequest]>(
    SttChannels.TRANSCRIBE,
    async (req: SttTranscribeRequest): Promise<SttTranscribeResult> => {
      if (!req || typeof req.audioBase64 !== 'string' || req.audioBase64.length === 0) {
        return { ok: false, error: 'no audio payload' }
      }
      const bytes = base64DecodedBytes(req.audioBase64)
      if (bytes > MAX_STT_AUDIO_BYTES) {
        return { ok: false, error: `audio exceeds the ${MAX_STT_AUDIO_BYTES} byte cap` }
      }
      try {
        if (!runtime) {
          booting ??= boot().catch((err) => {
            booting = null
            throw err
          })
          runtime = await booting
        }
        const wasReady = runtime.manager.status === 'ready'
        if (!wasReady) pushStatus({ status: 'starting' })
        const port = await runtime.manager.ensureStarted()
        if (!wasReady) pushStatus({ status: 'ready' })

        const prompt = await vocabularyPrompt(req.projectPath)
        const form = new FormData()
        const audio = Buffer.from(req.audioBase64, 'base64')
        form.append(
          'file',
          new Blob([audio], { type: req.mimeType || 'audio/wav' }),
          req.mimeType === 'audio/x-caf' ? 'audio.caf' : 'audio.wav',
        )
        form.append('response_format', 'json')
        form.append('temperature', '0.0')
        if (prompt) form.append('prompt', prompt)

        const res = await deps.fetchImpl(`http://127.0.0.1:${port}/inference`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(`whisper-server answered ${res.status}: ${body.slice(0, 200)}`)
        }
        const parsed = (await res.json()) as { text?: string; error?: string }
        if (typeof parsed.text !== 'string') {
          throw new Error(parsed.error ?? 'whisper-server returned no text')
        }
        runtime.manager.touch()
        log.info('transcription served', { bytes, durationMs: req.durationMs })
        return { ok: true, text: parsed.text.trim(), provider: 'whisper', modelId: WHISPER_MODEL_NAME }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('transcription failed', err)
        pushStatus({ status: 'error', detail: message })
        return { ok: false, error: message }
      }
    },
  )
}
