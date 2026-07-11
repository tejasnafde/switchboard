/** Real (side-effecting) provisioning deps: a child_process runner + the inputs. */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Machine } from '@shared/machines'
import { appRootDir, appVersion } from '../runtime'
import { createMainLogger } from '../logger'
import { provisionRemote, type ProcRunner } from './provisioner'
import type { ProvisionHooks } from './connectionManager'

const log = createMainLogger('machines:provision')

// Cap on captured child output. `cat > file` produces no stdout, but a
// misbehaving remote (sudo retry loop, an echoing pipe) can spew without
// bound; the old `stdout += d` grew the string until the process OOM'd. 1 MB
// is far more than enough to surface any real error message.
const MAX_CAPTURE = 1024 * 1024

// Ceiling on any single provisioning command. Generous because `npm install`
// on a slow VM legitimately takes minutes; the point is that a hung ssh (dead
// forward, remote wedged mid-stream) can no longer block connect forever.
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000

// Grace between SIGTERM and SIGKILL when the timeout fires.
const KILL_GRACE_MS = 5000

/**
 * Build a ProcRunner exec. `onSpawn` (when given) receives a kill handle for
 * every child the moment it spawns, so a user cancel (disconnect) can reap an
 * in-flight provisioning ssh instead of letting it run to completion.
 */
export function makeExecProc(onSpawn?: (child: { kill: () => void }) => void): ProcRunner['exec'] {
  return (command, args, stdin, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args)
    onSpawn?.({ kill: () => child.kill() })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLen = 0
    let errLen = 0
    child.stdout.on('data', (d: Buffer) => {
      if (outLen < MAX_CAPTURE) { out.push(d); outLen += d.length }
    })
    child.stderr.on('data', (d: Buffer) => {
      if (errLen < MAX_CAPTURE) { err.push(d); errLen += d.length }
    })
    let timedOut = false
    let hardKill: ReturnType<typeof setTimeout> | undefined
    const killTimer = setTimeout(() => {
      timedOut = true
      log.warn(`exec timed out after ${timeoutMs}ms, killing`, { command })
      child.kill('SIGTERM')
      hardKill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)
    const finish = (code: number, stderrOverride?: string) => {
      clearTimeout(killTimer)
      if (hardKill) clearTimeout(hardKill)
      if (timedOut) {
        reject(new Error(`command timed out after ${timeoutMs / 1000}s`))
        return
      }
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: stderrOverride ?? Buffer.concat(err).toString('utf-8'),
      })
    }
    child.on('error', (e) => finish(1, e.message))
    child.on('close', (code) => finish(code ?? 1))
    if (stdin !== undefined) {
      // ssh exiting mid-write raises EPIPE; swallow it here - the 'close'
      // handler above still reports the real exit code + stderr.
      child.stdin.on('error', () => {})
      if (typeof stdin === 'string') {
        child.stdin.end(stdin)
      } else {
        // Stream the file straight into stdin: no full-file buffer, no UTF-16
        // string doubling, and pipe() applies backpressure and ends the stream.
        // On a read error, kill the child and fail loudly rather than end()-ing
        // stdin cleanly - a clean EOF would make `cat` exit 0 with a truncated
        // (or empty) bundle and the step would falsely report success.
        const rs = createReadStream(stdin.file)
        rs.on('error', (e) => {
          child.kill()
          finish(1, `bundle read failed: ${e.message}`)
        })
        rs.pipe(child.stdin)
      }
    }
  })
}

export const execProc: ProcRunner['exec'] = makeExecProc()

function readServerBundlePath(): string {
  // Shipped inside the asar via `out/**` (build runs build:server); dev reads it
  // from the repo. appRootDir is the asar root packaged, the repo root in dev.
  // Returns the path (streamed into stdin at upload) rather than the contents.
  const path = join(appRootDir(), 'out/server/index.cjs')
  if (!existsSync(path)) throw new Error('server bundle missing; run `npm run build:server`')
  return path
}

function depVersion(name: string): string {
  const pkg = JSON.parse(readFileSync(join(appRootDir(), 'package.json'), 'utf-8'))
  return String(pkg.dependencies?.[name] ?? '').replace(/^[\^~]/, '')
}

/** Bundle the real deps into the ConnectionManager `provision` hook. */
export function makeProvision(log?: (msg: string) => void) {
  return (machine: Machine, hooks?: ProvisionHooks) =>
    provisionRemote(
      machine,
      {
        appVersion: appVersion(),
        betterSqliteVersion: depVersion('better-sqlite3'),
        claudeSdkVersion: depVersion('@anthropic-ai/claude-agent-sdk'),
        bundlePath: readServerBundlePath(),
      },
      { exec: makeExecProc(hooks?.onChild) },
      log,
      hooks?.onProgress,
    )
}
