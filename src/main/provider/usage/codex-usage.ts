/**
 * Codex subscription usage, read from a short-lived `codex app-server`.
 *
 * `account/rateLimits/read` needs only `initialize` + `initialized` - no
 * thread, no turn, no experimental flag. A throwaway server per click keeps
 * this off the chat hot path rather than injecting an RPC into a session
 * that may be mid-turn. The binary is ~260MB, so every exit path funnels
 * through one idempotent `dispose()`, and `disposeUsageProbes()` drains any
 * stragglers on quit.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { homedir } from 'os'
import { createInterface, type Interface } from 'readline'
import { parseCodexRateLimits } from '@shared/codex-usage-parse'
import type { ProviderUsage } from '@shared/provider-usage'
import { oauthLoginCommand } from '@shared/provider-auth-format'
import { createMainLogger } from '../../logger'
import { redactSecrets } from './redact'

const log = createMainLogger('provider:usage-codex')

/**
 * Deliberately far tighter than the adapter's INIT_TIMEOUT_MS of 30s. That
 * budget is sized for starting a chat session; a settings button that hangs
 * for 30 seconds reads as broken.
 */
const INIT_TIMEOUT_MS = 8000
const ACCOUNT_TIMEOUT_MS = 3000
const RATE_LIMITS_TIMEOUT_MS = 5000
const TOTAL_BUDGET_MS = 12_000
/** A freshly spawned server can answer before its snapshot is populated. */
const EMPTY_SNAPSHOT_RETRY_MS = 750
const SIGKILL_GRACE_MS = 1500
const STDERR_CAPTURE_LIMIT = 2000
const STDOUT_CAPTURE_LIMIT = 512 * 1024

const CLIENT_INFO = { name: 'switchboard', title: 'Switchboard', version: '0.1.0' }

const liveProbes = new Set<ChildProcessWithoutNullStreams>()

/** Kill any probe still running. Wired into the app's before-quit handler. */
export function disposeUsageProbes(): void {
  for (const child of liveProbes) {
    try {
      child.kill('SIGKILL')
    } catch {
      log.warn('failed to kill a usage probe during shutdown')
    }
  }
  liveProbes.clear()
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

class CodexProbeSession {
  private child: ChildProcessWithoutNullStreams
  private rl: Interface
  private pending = new Map<number, PendingRpc>()
  private nextId = 1
  private disposed = false
  private stderrBuf = ''
  private stdoutBytes = 0

  constructor(bin: string, env: Record<string, string>) {
    // RUST_LOG is inherited from process.env via buildCodexCliEnv, and stderr
    // is surfaced to the user - a trace-level run dumps ~240KB of request
    // detail into a settings card. The probe needs none of it.
    const probeEnv = { ...env }
    delete probeEnv.RUST_LOG
    // cwd must exist or spawn throws; the probe never touches the filesystem.
    this.child = spawn(bin, ['app-server'], {
      cwd: homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: probeEnv,
    }) as ChildProcessWithoutNullStreams
    liveProbes.add(this.child)

    this.rl = createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this.handleLine(line))

    this.child.stderr.on('data', (chunk: Buffer) => {
      // Slice on append: checking the length first lets a single 64KB pipe
      // chunk through whole, and all of it ends up in a user-facing message.
      if (this.stderrBuf.length >= STDERR_CAPTURE_LIMIT) return
      this.stderrBuf = (this.stderrBuf + chunk.toString('utf-8')).slice(0, STDERR_CAPTURE_LIMIT)
    })

    // Writing to a child that has already exited emits EPIPE on stdin, which
    // is an unhandled stream error (and so a crash) without a listener.
    this.child.stdin.on('error', (err) => {
      log.debug(`usage probe stdin error: ${err.message}`)
    })

    // Without this the outer promise would hang forever on ENOENT/EACCES.
    this.child.on('error', (err) => this.failAll(err))
    this.child.on('close', (code) => {
      this.failAll(new Error(`codex app-server exited (code ${code ?? 'null'})`))
    })
  }

  private handleLine(line: string): void {
    this.stdoutBytes += line.length
    if (this.stdoutBytes > STDOUT_CAPTURE_LIMIT) {
      this.failAll(new Error('codex app-server produced too much output'))
      return
    }
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: unknown
    try {
      msg = JSON.parse(trimmed)
    } catch {
      // app-server interleaves plain-text diagnostics with JSON-RPC frames;
      // a non-JSON line is expected noise, not a failure.
      return
    }
    if (typeof msg !== 'object' || msg === null) return
    const record = msg as Record<string, unknown>
    if (typeof record.id !== 'number') return
    const entry = this.pending.get(record.id)
    if (!entry) return
    this.pending.delete(record.id)
    if (record.error) {
      const err = record.error as Record<string, unknown>
      entry.reject(new Error(typeof err.message === 'string' ? err.message : 'JSON-RPC error'))
      return
    }
    entry.resolve(record.result)
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err)
    this.pending.clear()
  }

  send(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('probe already disposed'))
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
      try {
        this.child.stdin.write(`${payload}\n`)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  notify(method: string): void {
    if (this.disposed) return
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
    } catch {
      log.warn(`failed to send ${method} notification to the usage probe`)
    }
  }

  /** Shown to the user, so never trust the child's choice of what to print. */
  get stderr(): string {
    return redactSecrets(this.stderrBuf).trim()
  }

  /**
   * Idempotent teardown. Listeners are removed BEFORE the kill so a late
   * stdout line cannot resolve an already-settled promise.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.failAll(new Error('probe disposed'))
    try {
      this.rl.removeAllListeners()
      this.rl.close()
      this.child.stdout.removeAllListeners()
      this.child.stderr.removeAllListeners()
      this.child.stdin.removeAllListeners('error')
      this.child.stdin.on('error', () => {})
      this.child.removeAllListeners('close')
      this.child.removeAllListeners('error')
      // A dead child still emits 'error' on write; swallow it.
      this.child.on('error', () => {})
      this.child.stdin.end()
      this.child.kill('SIGTERM')
    } catch {
      log.warn('usage probe teardown hit an error before SIGKILL')
    }
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.kill('SIGKILL')
        } catch {
          log.warn('SIGKILL of a usage probe failed')
        }
      }
      liveProbes.delete(this.child)
    }, SIGKILL_GRACE_MS)
    timer.unref?.()
    this.child.once('close', () => {
      clearTimeout(timer)
      liveProbes.delete(this.child)
    })
  }
}

function base(instanceId: string, fetchedAtMs: number): ProviderUsage {
  return {
    instanceId,
    agentType: 'codex',
    status: 'error',
    plan: null,
    account: null,
    windows: [],
    overage: [],
    fetchedAtMs,
  }
}

function readAccount(result: unknown): { account: string | null; plan: string | null; isApiKey: boolean } {
  if (typeof result !== 'object' || result === null) return { account: null, plan: null, isApiKey: false }
  const acct = (result as Record<string, unknown>).account
  if (typeof acct !== 'object' || acct === null) return { account: null, plan: null, isApiKey: false }
  const record = acct as Record<string, unknown>
  return {
    account: typeof record.email === 'string' ? record.email : null,
    plan: typeof record.planType === 'string' ? record.planType : null,
    isApiKey: record.type === 'apiKey',
  }
}

export async function fetchCodexUsage(
  instanceId: string,
  env: Record<string, string>,
  bin: string,
  oauthDir: string | null,
): Promise<ProviderUsage> {
  const started = Date.now()
  const result = base(instanceId, started)
  const loginCommand = oauthLoginCommand('codex', oauthDir || env.CODEX_HOME || '~/.codex')

  let probe: CodexProbeSession
  try {
    probe = new CodexProbeSession(bin, env)
  } catch (err) {
    return { ...result, status: 'error', message: `Could not start codex app-server: ${err instanceof Error ? err.message : String(err)}` }
  }

  const deadline = started + TOTAL_BUDGET_MS
  const remaining = (cap: number) => Math.max(500, Math.min(cap, deadline - Date.now()))

  try {
    await probe.send('initialize', { clientInfo: CLIENT_INFO }, remaining(INIT_TIMEOUT_MS))
    probe.notify('initialized')

    // Best-effort: tells an API-key login apart from a subscription, and is
    // the cheapest source of the plan label. Marked deprecated in current
    // builds but still served; its failure must not fail the probe.
    let account: { account: string | null; plan: string | null; isApiKey: boolean } = {
      account: null, plan: null, isApiKey: false,
    }
    try {
      // Needs an explicit params object; omitting it is rejected with
      // "Invalid request: missing field `params`".
      account = readAccount(await probe.send('account/read', {}, remaining(ACCOUNT_TIMEOUT_MS)))
    } catch (err) {
      log.debug(`account/read unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }

    let parsed = parseCodexRateLimits(await probe.send('account/rateLimits/read', undefined, remaining(RATE_LIMITS_TIMEOUT_MS)))

    // A cold server can answer before its snapshot is populated. One retry
    // separates "not ready yet" from "genuinely has no limits". Failures here
    // must not discard the first answer, which is already valid.
    if (parsed.ok && parsed.allNull && Date.now() + EMPTY_SNAPSHOT_RETRY_MS + 1000 < deadline) {
      await new Promise((r) => setTimeout(r, EMPTY_SNAPSHOT_RETRY_MS))
      try {
        const retry = parseCodexRateLimits(await probe.send('account/rateLimits/read', undefined, remaining(RATE_LIMITS_TIMEOUT_MS)))
        if (retry.ok && !retry.allNull) parsed = retry
      } catch (err) {
        log.debug(`rate-limit retry failed, keeping the first snapshot: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const plan = parsed.plan ?? account.plan

    if (!parsed.ok) {
      return { ...result, status: 'error', plan, account: account.account, message: parsed.error ?? 'Rate-limit response could not be parsed.' }
    }
    if (parsed.allNull) {
      return account.isApiKey
        ? { ...result, status: 'not-applicable', plan, account: account.account, message: 'Plan limits do not apply - this instance authenticates with an API key.' }
        : { ...result, status: 'not-applicable', plan, account: account.account, message: 'Codex reported no usage limits for this account.' }
    }

    return {
      ...result,
      status: 'ok',
      plan,
      account: account.account,
      windows: parsed.windows,
      overage: parsed.overage,
    }
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err))
    const stderr = probe.stderr
    log.warn(`codex usage probe failed: ${message}`)
    // A failed initialize is nearly always "not logged in for this CODEX_HOME".
    return {
      ...result,
      status: 'error',
      message: stderr ? `${message}. Codex stderr: ${stderr}` : message,
      ...(loginCommand ? { command: loginCommand } : {}),
    }
  } finally {
    probe.dispose()
  }
}
