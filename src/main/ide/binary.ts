/**
 * code-server binary bootstrap: resolve an existing install, or download the
 * release tarball to userData/code-server/<version>/ and extract it with the
 * system tar (zero new npm deps). Never bundled in the app package.
 */
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CODE_SERVER_VERSION, resolveDownloadAsset } from './code-server-manager'
import { createMainLogger } from '../logger'

const execFileP = promisify(execFile)
const log = createMainLogger('ide:binary')

function installDir(userDataRoot: string): string {
  return join(userDataRoot, 'code-server', CODE_SERVER_VERSION)
}

/** The tarball extracts to code-server-<version>-<platform-arch>/bin/code-server. */
function installedBinaryPath(userDataRoot: string): string {
  const { assetName } = resolveDownloadAsset(CODE_SERVER_VERSION, process.platform, process.arch)
  const topDir = assetName.replace(/\.tar\.gz$/, '')
  return join(installDir(userDataRoot), topDir, 'bin', 'code-server')
}

async function pathBinary(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('which', ['code-server'])
    const p = stdout.trim()
    return p.length > 0 ? p : null
  } catch {
    return null
  }
}

/**
 * Resolve the code-server binary: previous download → PATH (dev convenience)
 * → fresh download. `onDownloadStart` fires only when a network fetch begins,
 * so the renderer can show the one-time progress state.
 */
export async function ensureBinary(userDataRoot: string, onDownloadStart?: () => void): Promise<string> {
  const installed = installedBinaryPath(userDataRoot)
  if (existsSync(installed)) return installed

  const onPath = await pathBinary()
  if (onPath) {
    log.info('using code-server from PATH', { path: onPath })
    return onPath
  }

  onDownloadStart?.()
  const { url, assetName } = resolveDownloadAsset(CODE_SERVER_VERSION, process.platform, process.arch)
  log.info('downloading code-server', { url })
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`code-server download failed: HTTP ${res.status} for ${url}`)
  }
  const tarPath = join(tmpdir(), assetName)
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tarPath))

  const dir = installDir(userDataRoot)
  mkdirSync(dir, { recursive: true })
  try {
    await execFileP('tar', ['-xzf', tarPath, '-C', dir])
  } finally {
    rmSync(tarPath, { force: true })
  }
  if (!existsSync(installed)) {
    throw new Error(`code-server tarball extracted but binary missing at ${installed}`)
  }
  log.info('code-server installed', { path: installed })
  return installed
}
