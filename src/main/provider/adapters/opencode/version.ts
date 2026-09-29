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
import { statSync } from 'node:fs'
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

export type VersionRunner = (bin: string, env: Record<string, string>) => Promise<string>

const runVersion: VersionRunner = (bin, env) => new Promise((resolve, reject) => {
  // stdout only: a Node wrapper's stderr warnings can carry Node's own version.
  const child = execFile(bin, ['--version'], { env, timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout) => {
    if (err) return reject(err)
    resolve(stdout)
  })
  // Nothing to read from us; a CLI that waits on stdin must not hang the check.
  child.stdin?.end()
})

/** Keyed by path + mtime + size, so an in-place upgrade or downgrade is re-read. */
const cache = new Map<string, Promise<OpencodeVersion | null>>()

function cacheKey(bin: string): string | null {
  try {
    const st = statSync(bin)
    return `${bin}\0${st.mtimeMs}\0${st.size}`
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
  run: VersionRunner = runVersion,
): Promise<OpencodeVersion | null> {
  const key = cacheKey(bin)
  const hit = key ? cache.get(key) : undefined
  if (hit) return hit
  const read = run(bin, env).then(
    (output) => {
      const version = parseOpencodeVersion(output)
      if (!version) log.warn(`could not parse opencode --version output from ${bin}`, { output: output.slice(0, 200) })
      else log.info(`opencode ${version.raw} at ${bin}`)
      return version
    },
    (err: unknown) => {
      log.warn(`opencode --version failed for ${bin}; treating it as supported`, err)
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
 * Throws OpencodeUnsupportedVersionError for a 2.x (or later) binary. An
 * unreadable version is let through: refusing on a failed read would lock out
 * a working 1.x install.
 */
export async function assertSupportedOpencode(
  bin: string,
  env: Record<string, string>,
  run?: VersionRunner,
): Promise<void> {
  const version = await readOpencodeVersion(bin, env, run)
  if (version && version.major >= OPENCODE_FIRST_UNSUPPORTED_MAJOR) {
    throw new OpencodeUnsupportedVersionError(version.raw, bin)
  }
}

export function _resetOpencodeVersionCacheForTests(): void {
  cache.clear()
}
