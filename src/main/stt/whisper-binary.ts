/**
 * whisper.cpp server bootstrap, on the code-server pattern (src/main/ide/
 * binary.ts): resolve a previous install or PATH binary, else download the
 * release tarball to userData/whisper/<version>/ and extract with the system
 * tar. Never bundled in the app package.
 *
 * Release-asset reality (verified against ggml-org/whisper.cpp v1.9.2 by
 * listing the release and the archives themselves, 2026-08-09):
 *   - Linux: whisper-bin-ubuntu-{x64,arm64}.tar.gz, extracting to
 *     whisper-bin-ubuntu-<arch>/whisper-server with its libwhisper/libggml
 *     shared objects alongside (hence the LD_LIBRARY_PATH overlay below);
 *   - Windows x64: whisper-bin-x64.zip, extracting to
 *     Release/whisper-server.exe with its DLLs alongside (the exe dir is on
 *     the Windows DLL search path, so no env overlay is needed);
 *   - macOS: an xcframework only, NO server binary. So on darwin the only
 *     resolution paths are a previous manual install or `whisper-server` on
 *     PATH (e.g. `brew install whisper-cpp`); resolveWhisperAsset returns null
 *     there and callers surface a clear "not installed" error instead of
 *     downloading.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMainLogger } from '../logger'

const execFileP = promisify(execFile)
const log = createMainLogger('stt:binary')

export const WHISPER_VERSION = 'v1.9.2'

/** Release asset per (platform, arch). No darwin entry: macOS ships no server. */
const ASSETS: Record<string, { assetName: string; serverRelPath: string }> = {
  'linux-x64': {
    assetName: 'whisper-bin-ubuntu-x64.tar.gz',
    serverRelPath: 'whisper-bin-ubuntu-x64/whisper-server',
  },
  'linux-arm64': {
    assetName: 'whisper-bin-ubuntu-arm64.tar.gz',
    serverRelPath: 'whisper-bin-ubuntu-arm64/whisper-server',
  },
  'win32-x64': {
    assetName: 'whisper-bin-x64.zip',
    serverRelPath: join('Release', 'whisper-server.exe'),
  },
}

export interface WhisperAsset {
  assetName: string
  url: string
  /** Path of whisper-server inside the extracted archive. */
  serverRelPath: string
}

/** Null = no prebuilt whisper-server for this platform (darwin). */
export function resolveWhisperAsset(version: string, platform: string, arch: string): WhisperAsset | null {
  const asset = ASSETS[`${platform}-${arch}`]
  if (!asset) return null
  return {
    ...asset,
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${version}/${asset.assetName}`,
  }
}

/**
 * Model download URL. The canonical ggml model host is the ggerganov HF repo;
 * the ggml-org mirror answers 401 for anonymous downloads (verified 2026-08-08).
 */
export function whisperModelUrl(modelName: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelName}`
}

export function whisperModelPath(userDataRoot: string, modelName: string): string {
  return join(userDataRoot, 'whisper', 'models', modelName)
}

function installDir(userDataRoot: string): string {
  return join(userDataRoot, 'whisper', WHISPER_VERSION)
}

function installedServerPath(userDataRoot: string, asset: WhisperAsset): string {
  return join(installDir(userDataRoot), asset.serverRelPath)
}

/**
 * The Linux release binaries link libwhisper/libggml shared objects sitting
 * next to the executable, so a downloaded install needs its own dir on
 * LD_LIBRARY_PATH. A PATH/brew binary resolves its libs itself, and Windows
 * finds the DLLs in the exe's own dir without help.
 */
export function whisperSpawnEnv(
  binaryPath: string,
  platform: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (platform !== 'linux') return { ...baseEnv }
  const libDir = dirname(binaryPath)
  const existing = baseEnv.LD_LIBRARY_PATH
  return { ...baseEnv, LD_LIBRARY_PATH: existing ? `${libDir}:${existing}` : libDir }
}

async function pathBinary(): Promise<string | null> {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileP(probe, ['whisper-server'])
    // `where` prints every match, one per line; the first is what a shell runs.
    const p = stdout.split(/\r?\n/, 1)[0].trim()
    return p.length > 0 ? p : null
  } catch (err) {
    // Exit 1 = not on PATH (the expected negative). Anything else is worth a trace.
    if ((err as { code?: number }).code !== 1) log.warn('PATH probe for whisper-server failed', err)
    return null
  }
}

async function downloadWithProgress(
  url: string,
  destination: string,
  onProgress?: (pct: number | null) => void,
): Promise<void> {
  onProgress?.(null)
  const res = await fetch(url, { signal: AbortSignal.timeout(20 * 60 * 1000) })
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  let lastPct = -1
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      if (total > 0) {
        const pct = Math.floor((received / total) * 100)
        if (pct >= lastPct + 5) {
          lastPct = pct
          log.info('download progress', { url, pct })
          onProgress?.(pct)
        }
      }
      cb(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(destination))
}

/**
 * Resolve the whisper-server binary: previous download → PATH → fresh
 * download where a release asset exists. Null = nothing resolvable on this
 * platform; the caller owns the user-facing error copy.
 */
export async function ensureWhisperBinary(
  userDataRoot: string,
  onDownloadProgress?: (pct: number | null) => void,
): Promise<string | null> {
  const asset = resolveWhisperAsset(WHISPER_VERSION, process.platform, process.arch)
  if (asset) {
    const installed = installedServerPath(userDataRoot, asset)
    if (existsSync(installed)) return installed
  }

  const onPath = await pathBinary()
  if (onPath) {
    log.info('using whisper-server from PATH', { path: onPath })
    return onPath
  }

  if (!asset) return null

  log.info('downloading whisper.cpp server', { url: asset.url })
  const archivePath = join(tmpdir(), asset.assetName)
  await downloadWithProgress(asset.url, archivePath, onDownloadProgress)
  const dir = installDir(userDataRoot)
  mkdirSync(dir, { recursive: true })
  try {
    // Plain -xf: bsdtar (macOS, Windows 10+) detects the format itself, which
    // covers both the Linux .tar.gz and the Windows .zip. GNU tar on Linux
    // only ever sees the .tar.gz, which -xf also handles.
    await execFileP('tar', ['-xf', archivePath, '-C', dir])
  } finally {
    rmSync(archivePath, { force: true })
  }
  const installed = installedServerPath(userDataRoot, asset)
  if (!existsSync(installed)) {
    throw new Error(`whisper tarball extracted but binary missing at ${installed}`)
  }
  log.info('whisper-server installed', { path: installed })
  return installed
}

/**
 * Download the ggml model to userData on first use. Atomic: streamed to a
 * temp file in the destination dir, renamed into place only when complete, so
 * a killed download never leaves a truncated model that whisper would choke on.
 */
export async function ensureWhisperModel(
  userDataRoot: string,
  modelName: string,
  onDownloadProgress?: (pct: number | null) => void,
): Promise<string> {
  const modelPath = whisperModelPath(userDataRoot, modelName)
  if (existsSync(modelPath)) return modelPath
  mkdirSync(dirname(modelPath), { recursive: true })
  const tempPath = `${modelPath}.download-${process.pid}`
  log.info('downloading whisper model', { modelName })
  try {
    await downloadWithProgress(whisperModelUrl(modelName), tempPath, onDownloadProgress)
    renameSync(tempPath, modelPath)
  } catch (err) {
    rmSync(tempPath, { force: true })
    throw err
  }
  log.info('whisper model installed', { path: modelPath })
  return modelPath
}
