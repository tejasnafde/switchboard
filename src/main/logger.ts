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
import { app } from 'electron'

const RETENTION_DAYS = 7
const LOG_DIR_NAME = 'logs'

let logDir: string
let logFilePath: string
let initialized = false

function init(): void {
  if (initialized) return
  initialized = true

  try {
    logDir = join(app.getPath('userData'), LOG_DIR_NAME)
    mkdirSync(logDir, { recursive: true })

    const date = new Date().toISOString().slice(0, 10) // 2026-04-20
    const time = new Date().toISOString().slice(11, 19).replace(/:/g, '') // 020530
    logFilePath = join(logDir, `switchboard-${date}-${time}-${process.pid}.log`)

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
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
}

function writeRaw(line: string): void {
  if (!logFilePath) return
  try {
    appendFileSync(logFilePath, line)
  } catch { /* ignore write failures */ }
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
