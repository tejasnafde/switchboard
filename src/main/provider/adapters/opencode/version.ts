/**
 * OpenCode major-version gate.
 *
 * OpenCode 2.x ships under the same `opencode` binary name but breaks the
 * ACP surface we drive: `opencode acp --cwd` is rejected, `session/set_model`
 * is gone, and `opencode models` attaches to a shared background service
 * (see AGENTS.md, OpenCode section). Until a v2 path exists every spawn site
 * refuses a 2.x binary with one clear message instead of a CLI usage error.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { createMainLogger } from '../../../logger'

const log = createMainLogger('provider:opencode:version')

const VERSION_TIMEOUT_MS = 10_000

export const OPENCODE_FIRST_UNSUPPORTED_MAJOR = 2

export interface OpencodeVersion {
  raw: string
  major: number
}

/**
 * The version `opencode --version` printed, or null when nothing in it looks
 * like one. Accepts `1.18.33`, `v2.0.19` and `opencode 2.0.19`.
 */
export function parseOpencodeVersion(output: string): OpencodeVersion | null {
  const match = /(?:^|[\s(])v?((\d+)\.\d+(?:\.\d+)?(?:[-+][\w.-]*)?)(?=$|[\s),])/m.exec(output)
  if (!match) return null
  const major = Number(match[2])
  if (!Number.isSafeInteger(major)) return null
  return { raw: match[1], major }
}

export class OpencodeUnsupportedVersionError extends Error {
  readonly code = 'SWITCHBOARD_OPENCODE_UNSUPPORTED'
  constructor(public readonly version: string, public readonly binPath: string) {
    super(
      `OpenCode ${version} is not supported yet (found at ${binPath}). ` +
        `Switchboard works with OpenCode 1.x only for now. Install OpenCode 1.x ` +
        `(npm i -g opencode-ai) or switch back, then try again.`,
    )
    this.name = 'OpencodeUnsupportedVersionError'
  }
}

export type VersionRunner = (bin: string, env: Record<string, string>, cwd?: string) => Promise<string>

/**
 * Why `bin` is an OpenCode 2.x install, judged from the files alone (nothing
 * is run), or null. Only consulted when `--version` gave no answer, so a 2.x
 * binary that cannot report its version is still refused before it can
 * migrate opencode.db forward. v1 has none of these:
 * - an `opencode2` shim beside it: the v2 curl installer writes one, and
 *   `@opencode/cli` declares it as a second npm bin;
 * - a real path inside the `@opencode/cli` npm package or brew's
 *   `opencode-v2` formula.
 */
export function opencodeV2InstallSignal(bin: string): string | null {
  let real = bin
  try {
    real = realpathSync(bin)
  } catch (err) {
    log.debug(`cannot resolve opencode binary ${bin}`, err)
  }
  const inside = (part: string) => real.includes(`${sep}${part}${sep}`)
  if (inside(join('node_modules', '@opencode', 'cli'))) return 'installed from the @opencode/cli package'
  if (inside(join('Cellar', 'opencode-v2'))) return 'installed from the opencode-v2 Homebrew formula'
  for (const dir of new Set([dirname(bin), dirname(real)])) {
    if (existsSync(join(dir, 'opencode2'))) return `has an opencode2 shim beside it in ${dir}`
  }
  return null
}

const runVersion: VersionRunner = (bin, env, cwd) => new Promise((resolve, reject) => {
  // stdout only: a Node wrapper's stderr warnings can carry Node's own version.
  // The spawn's own cwd, so a per-directory version shim picks what the session will run.
  const child = execFile(bin, ['--version'], { env, cwd, timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout) => {
    if (err) return reject(err)
    resolve(stdout)
  })
  // Nothing to read from us; a CLI that waits on stdin must not hang the check.
  child.stdin?.end()
})

/** Env keys a wrapper or version manager can use to pick which binary runs. */
const BINARY_SELECTING_ENV = /^(PATH|HOME|OPENCODE_.*|XDG_.*|MISE_.*|ASDF_.*|VOLTA_.*|NVM_.*|NODE_.*|NPM_CONFIG_.*|BUN_.*)$/

/**
 * A hash of the binary-selecting env, so two instances whose env can resolve
 * a wrapper differently never share a cached answer. Only the hash is kept;
 * values are never logged.
 */
export function opencodeEnvFingerprint(env: Record<string, string>): string {
  const hash = createHash('sha256')
  for (const key of Object.keys(env).filter((k) => BINARY_SELECTING_ENV.test(k)).sort()) {
    hash.update(`${key}\0${env[key]}\0`)
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Keyed by path + mtime + size, so an in-place upgrade or downgrade is re-read,
 * by cwd, since a version shim can resolve differently per project, and by the
 * env fingerprint, since a wrapper can pick its install from the env.
 */
const cache = new Map<string, Promise<OpencodeVersion | null>>()

function cacheKey(bin: string, env: Record<string, string>, cwd: string | undefined): string | null {
  try {
    const st = statSync(bin)
    return `${bin}\0${st.mtimeMs}\0${st.size}\0${cwd ?? ''}\0${opencodeEnvFingerprint(env)}`
  } catch (err) {
    log.warn(`cannot stat opencode binary ${bin}; version not cached`, err)
    return null
  }
}

/**
 * The binary's version, read once per binary. A failed read resolves null and
 * is not cached, so a transient failure is retried on the next spawn.
 */
export function readOpencodeVersion(
  bin: string,
  env: Record<string, string>,
  cwd?: string,
  run: VersionRunner = runVersion,
): Promise<OpencodeVersion | null> {
  const key = cacheKey(bin, env, cwd)
  const hit = key ? cache.get(key) : undefined
  if (hit) return hit
  const read = run(bin, env, cwd).then(
    (output) => {
      const version = parseOpencodeVersion(output)
      // Its size only: a wrapper's stdout can carry anything it inherited, keys included.
      if (!version) log.warn(`could not parse opencode --version output from ${bin}`, { bytes: Buffer.byteLength(output) })
      else log.info(`opencode ${version.raw} at ${bin}`)
      return version
    },
    (err: unknown) => {
      // Not the error itself: execFile puts the child's stderr in its message.
      const { code, signal, killed } = (err ?? {}) as { code?: unknown; signal?: unknown; killed?: unknown }
      log.warn(`opencode --version failed for ${bin}`, { code, signal, killed })
      return null
    },
  )
  if (key) {
    cache.set(key, read)
    void read.then((version) => { if (!version) cache.delete(key) })
  }
  return read
}

/**
 * Throws OpencodeUnsupportedVersionError for a 2.x (or later) binary. When
 * `--version` gives no answer, the install's files decide
 * (`opencodeV2InstallSignal`); with neither, the binary is let through, since
 * refusing on a failed read would lock out a working 1.x install. That last
 * case can still run an unrecognised 2.x.
 */
export async function assertSupportedOpencode(
  bin: string,
  env: Record<string, string>,
  cwd?: string,
  run?: VersionRunner,
): Promise<void> {
  const version = await readOpencodeVersion(bin, env, cwd, run)
  if (version) {
    if (version.major >= OPENCODE_FIRST_UNSUPPORTED_MAJOR) throw new OpencodeUnsupportedVersionError(version.raw, bin)
    return
  }
  const signal = opencodeV2InstallSignal(bin)
  if (signal) {
    log.warn(`opencode at ${bin} gave no version but ${signal}; refusing it as 2.x`)
    throw new OpencodeUnsupportedVersionError('2.x', bin)
  }
  log.warn(`opencode at ${bin} gave no version and looks like 1.x; letting it run`)
}

export function _resetOpencodeVersionCacheForTests(): void {
  cache.clear()
}
