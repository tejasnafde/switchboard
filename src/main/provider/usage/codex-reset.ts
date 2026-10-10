/**
 * Spend one banked Codex rate-limit reset through a short-lived
 * `codex app-server`, the same probe and env the usage read uses.
 *
 * `account/rateLimitResetCredit/consume` takes an idempotency key. The key is
 * minted here, on the click, and kept per instance until Codex gives a
 * terminal answer, so a retry after a timeout or a lost reply sends the same
 * key and can never spend a second reset. The key is never logged.
 */

import { randomUUID } from 'crypto'
import { isTerminalOutcome, parseConsumeOutcome, type CodexResetOutcome } from '@shared/codex-reset'
import { createMainLogger } from '../../logger'
import { redactSecrets } from './redact'
import { CodexProbeSession } from './codex-usage'

const log = createMainLogger('provider:usage-codex-reset')

const INIT_TIMEOUT_MS = 8000
/** A spend writes on the server, so it gets longer than a read. */
const CONSUME_TIMEOUT_MS = 15_000

const CLIENT_INFO = { name: 'switchboard', title: 'Switchboard', version: '0.1.0' }

export interface ResetAttempt {
  idempotencyKey: string
  creditId: string | null
}

/**
 * One pending attempt per instance. `take` returns the pending attempt when
 * there is one (a retry), else mints a new key for this click. `settle` drops
 * it on a terminal outcome and keeps it on `unknown`.
 */
export class ResetKeyBook {
  private pending = new Map<string, ResetAttempt>()

  constructor(private readonly mint: () => string = randomUUID) {}

  take(instanceId: string, creditId: string | null): ResetAttempt {
    const existing = this.pending.get(instanceId)
    if (existing) return existing
    const attempt = { idempotencyKey: this.mint(), creditId }
    this.pending.set(instanceId, attempt)
    return attempt
  }

  settle(instanceId: string, attempt: ResetAttempt, outcome: CodexResetOutcome): void {
    if (!isTerminalOutcome(outcome)) return
    if (this.pending.get(instanceId) === attempt) this.pending.delete(instanceId)
  }

  has(instanceId: string): boolean {
    return this.pending.has(instanceId)
  }

  /** The instance was deleted: its credential is gone, so is the attempt. */
  forget(instanceId?: string): void {
    if (instanceId === undefined) this.pending.clear()
    else this.pending.delete(instanceId)
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out/.test(err.message)
}

/**
 * Run one consume. Any failure to read an answer is `unknown`: the reset may
 * or may not have been applied, and the caller keeps the key. A timeout is
 * retried once in the same session with the same key.
 */
export async function consumeCodexReset(
  env: Record<string, string>,
  bin: string,
  attempt: ResetAttempt,
  consumeTimeoutMs = CONSUME_TIMEOUT_MS,
): Promise<CodexResetOutcome> {
  let probe: CodexProbeSession
  try {
    probe = new CodexProbeSession(bin, env)
  } catch (err) {
    log.warn(`could not start codex app-server for a reset: ${redactSecrets(err instanceof Error ? err.message : String(err))}`)
    return 'unknown'
  }
  const params = {
    idempotencyKey: attempt.idempotencyKey,
    ...(attempt.creditId ? { creditId: attempt.creditId } : {}),
  }
  try {
    await probe.send('initialize', { clientInfo: CLIENT_INFO }, INIT_TIMEOUT_MS)
    probe.notify('initialized')
    let result: unknown
    try {
      result = await probe.send('account/rateLimitResetCredit/consume', params, consumeTimeoutMs)
    } catch (err) {
      if (!isTimeout(err)) throw err
      log.warn('reset consume timed out, retrying once with the same key')
      result = await probe.send('account/rateLimitResetCredit/consume', params, consumeTimeoutMs)
    }
    const outcome = parseConsumeOutcome(result)
    if (outcome === 'unknown') log.warn('reset consume answered with an outcome Switchboard does not know')
    return outcome
  } catch (err) {
    const stderr = probe.stderr
    log.warn(`reset consume failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}${stderr ? ` (stderr ${Buffer.byteLength(stderr)} bytes)` : ''}`)
    return 'unknown'
  } finally {
    probe.dispose()
  }
}
