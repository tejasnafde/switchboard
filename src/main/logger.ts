/**
 * File-based logger for the main process.
 *
 * Writes to ~/Library/Application Support/switchboard/logs/ (or userData/logs/).
 * Each app launch creates a new log file: switchboard-{date}-{pid}.log
 * On startup, prunes log files older than 7 days.
 *
 * Also writes to console so dev mode `npm run dev` still shows logs.
 */

import { join } from 'path'
import { mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from 'fs'
import { appendFile } from 'fs/promises'
import { userDataDir } from './runtime'

const RETENTION_DAYS = 7
const LOG_DIR_NAME = 'logs'

let logDir: string
let logFilePath: string
let initialized = false

function init(): void {
  if (initialized) return
  initialized = true

  try {
    logDir = join(userDataDir(), LOG_DIR_NAME)
    mkdirSync(logDir, { recursive: true })

    const date = new Date().toISOString().slice(0, 10) // 2026-04-20
    const time = new Date().toISOString().slice(11, 19).replace(/:/g, '') // 020530
    logFilePath = join(logDir, `switchboard-${date}-${time}-${process.pid}.log`)

    // Crash-adjacent lines are the ones you need: drain the async buffer
    // synchronously on exit (also fires after uncaughtException's default
    // handler). Hard kills (SIGKILL/segfault) lose at most one tick of lines.
    process.on('exit', flushLogsSync)

    // Write header
    writeRaw(`=== Switchboard log started ${new Date().toISOString()} pid=${process.pid} ===\n`)

    // Prune old logs
    pruneOldLogs()
  } catch (err) {
    console.error('Failed to initialize file logger:', err)
  }
}

function pruneOldLogs(): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const files = readdirSync(logDir).filter((f) => f.startsWith('switchboard-') && f.endsWith('.log'))
    for (const file of files) {
      const full = join(logDir, file)
      try {
        const st = statSync(full)
        if (st.mtimeMs < cutoff) {
          unlinkSync(full)
        }
        // This IS the logger; logging a failure inside its own init path would recurse.
        // eslint-disable-next-line no-restricted-syntax -- see comment above
      } catch { /* skip - one stale log file left behind is not worth failing startup over */ }
    }
    // This IS the logger; logging a failure inside its own init path would recurse.
    // eslint-disable-next-line no-restricted-syntax -- see comment above
  } catch { /* ignore - pruning is best-effort and must never block startup */ }
}

// Buffered async sink. `appendFileSync` per log line used to block the main
// event loop once per call - and the provider adapters log per streamed
// frame, so a busy turn paid a sync disk write per token. Lines now buffer
// in memory and flush on the next tick via async appendFile; ordering is
// preserved by the single in-flight `flushing` gate.
const MAX_BUFFERED_LINES = 10_000
let buffer: string[] = []
let dropped = 0
let flushScheduled = false
let flushing = false

function writeRaw(line: string): void {
  if (!logFilePath) return
  if (buffer.length >= MAX_BUFFERED_LINES) {
    // ponytail: drop-newest under a stuck disk; a counter line records the gap
    dropped += 1
    return
  }
  buffer.push(line)
  scheduleFlush()
}

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  setImmediate(() => {
    flushScheduled = false
    void flushAsync()
  })
}

function drainBuffer(): string {
  let chunk = buffer.join('')
  buffer = []
  if (dropped > 0) {
    chunk += `[logger] dropped ${dropped} lines (buffer full)\n`
    dropped = 0
  }
  return chunk
}

async function flushAsync(): Promise<void> {
  if (flushing || !logFilePath || buffer.length === 0) return
  flushing = true
  const chunk = drainBuffer()
  try {
    await appendFile(logFilePath, chunk)
    // This IS the logger's own disk write; logging the failure would try to
    // write again and recurse.
    // eslint-disable-next-line no-restricted-syntax -- see comment above
  } catch { /* ignore write failures - console output still reaches the user */ }
  flushing = false
  if (buffer.length > 0) scheduleFlush()
}

/** Synchronously drain any buffered lines to disk. Called on process exit. */
export function flushLogsSync(): void {
  if (!logFilePath || buffer.length === 0) return
  try {
    appendFileSync(logFilePath, drainBuffer())
    // This IS the logger's own disk write, called from process exit; logging
    // the failure would recurse.
    // eslint-disable-next-line no-restricted-syntax -- see comment above
  } catch { /* ignore write failures - nothing left to do on the way out */ }
}

/**
 * Persist metadata immediately before a native boundary that can abort without
 * running Node's exit handlers. Callers must pass identifiers and byte counts,
 * never message/tool contents or credentials.
 */
export function writeCrashBreadcrumb(scope: string, metadata: Record<string, unknown>): void {
  init()
  if (!logFilePath) return
  try {
    appendFileSync(logFilePath, formatLine('BRD', scope, [metadata]))
    // This IS the logger's own disk write; logging the failure would recurse
    // into the same write path.
    // eslint-disable-next-line no-restricted-syntax -- see comment above
  } catch { /* diagnostics must never take down the app */ }
}

function formatLine(level: string, scope: string, args: unknown[]): string {
  const ts = new Date().toISOString()
  const parts = args.map((a) => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return `${a.message}\n${a.stack}`
    try { return JSON.stringify(a) } catch { return String(a) }
  })
  return `${ts} [${level}] [${scope}] ${parts.join(' ')}\n`
}

export function createMainLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => {
      init()
      const line = formatLine('DBG', scope, args)
      writeRaw(line)
      console.debug(`[SB:${scope}]`, ...args)
    },
    info: (...args: unknown[]) => {
      init()
      const line = formatLine('INF', scope, args)
      writeRaw(line)
      console.log(`[SB:${scope}]`, ...args)
    },
    warn: (...args: unknown[]) => {
      init()
      const line = formatLine('WRN', scope, args)
      writeRaw(line)
      console.warn(`[SB:${scope}]`, ...args)
    },
    error: (...args: unknown[]) => {
      init()
      const line = formatLine('ERR', scope, args)
      writeRaw(line)
      console.error(`[SB:${scope}]`, ...args)
    },
  }
}

/** Get the path to the current log file (for display in Settings/About) */
export function getLogFilePath(): string {
  init()
  return logFilePath ?? ''
}

/** Get the log directory */
export function getLogDir(): string {
  init()
  return logDir ?? ''
}
