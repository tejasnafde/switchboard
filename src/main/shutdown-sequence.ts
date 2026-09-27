/**
 * Ordered, awaited app teardown. Each step runs once, in order, and the next
 * starts only when the previous has settled or run out of time, so a step can
 * rely on everything before it being closed (the database closes last, after
 * every writer has stopped). A step that throws or hangs is logged and quit
 * carries on. No electron import, so it stays unit-testable.
 */

export interface ShutdownStep {
  name: string
  run: () => void | Promise<void>
  /** How long quit waits for this step before moving on. */
  timeoutMs?: number
}

export type ShutdownOutcome = 'ok' | 'failed' | 'timed-out'

export interface ShutdownStepReport {
  name: string
  outcome: ShutdownOutcome
  ms: number
}

export interface ShutdownLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

export interface ShutdownOptions {
  log: ShutdownLogger
  defaultTimeoutMs?: number
  now?: () => number
}

const DEFAULT_STEP_TIMEOUT_MS = 3_000

export async function runShutdownSequence(
  steps: readonly ShutdownStep[],
  { log, defaultTimeoutMs = DEFAULT_STEP_TIMEOUT_MS, now = Date.now }: ShutdownOptions,
): Promise<ShutdownStepReport[]> {
  const reports: ShutdownStepReport[] = []
  for (const step of steps) {
    const started = now()
    const outcome = await runStep(step, step.timeoutMs ?? defaultTimeoutMs, log)
    reports.push({ name: step.name, outcome, ms: now() - started })
  }
  log.info('shutdown finished', reports.map((r) => `${r.name}:${r.outcome}:${r.ms}ms`).join(' '))
  return reports
}

async function runStep(step: ShutdownStep, timeoutMs: number, log: ShutdownLogger): Promise<ShutdownOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const run = Promise.resolve().then(step.run)
    const timeout = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), timeoutMs)
    })
    const result = await Promise.race([run.then(() => 'ok' as const), timeout])
    if (result === 'timed-out') {
      log.warn(`shutdown step ${step.name} still running after ${timeoutMs}ms - moving on`)
      // It may still settle later; a late rejection must not surface as unhandled.
      run.catch((err) => log.warn(`shutdown step ${step.name} failed after timing out`, err))
    }
    return result
  } catch (err) {
    log.warn(`shutdown step ${step.name} failed`, err)
    return 'failed'
  } finally {
    clearTimeout(timer)
  }
}
