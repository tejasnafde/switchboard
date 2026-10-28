/**
 * A Claude Code CLI outlives the backend that started it: on stdin EOF it
 * still finishes its current turn, tools and all. After a crash or a
 * headless restart, a resumed chat would then put a second agent in the same
 * checkout. Each backend records the CLIs it runs in a ledger file named by
 * its pid, and on start stops the CLIs of every ledger whose backend is gone.
 *
 * A recorded child is stopped only when its pid still runs the exact command
 * line recorded for it, so a reused pid is never killed.
 */
import { execFile, spawnSync } from 'child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { createMainLogger } from '../logger'
import { userDataDir } from '../runtime'

const log = createMainLogger('provider:claude-orphans')
const execFileAsync = promisify(execFile)

/** Every CLI the SDK starts talks stream-json on stdin; probes do not. */
const CLI_MARK = '--input-format stream-json'
const KILL_GRACE_MS = 3_000
const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,command=']

interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

interface Ledger {
  ownerPid: number
  children: { pid: number; command: string }[]
}

export function claudeOrphanLedgerDir(): string {
  return join(userDataDir(), 'claude-cli-children')
}

function parsePs(out: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trim() })
  }
  return rows
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Writes the CLIs `ownerPid` runs now to its ledger, replacing what it held. */
export async function recordClaudeChildren(dir: string, ownerPid = process.pid): Promise<void> {
  if (process.platform === 'win32') return
  const { stdout } = await execFileAsync('ps', PS_ARGS, { maxBuffer: 16 * 1024 * 1024 })
  const children = parsePs(stdout)
    .filter((row) => row.ppid === ownerPid && row.command.includes(CLI_MARK))
    .map(({ pid, command }) => ({ pid, command }))
  const ledger: Ledger = { ownerPid, children }
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${ownerPid}.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify(ledger))
  renameSync(`${file}.tmp`, file)
}

let recording: Promise<void> = Promise.resolve()

/** Queues a ledger refresh for this process; called once a CLI has started. */
export function noteClaudeChildStarted(): void {
  recording = recording
    .then(() => recordClaudeChildren(claudeOrphanLedgerDir()))
    .catch((err) => log.warn('recording claude CLI children failed', err))
}

function descendants(rows: ProcessRow[], root: number): number[] {
  const found = [root]
  for (let i = 0; i < found.length; i++) {
    for (const row of rows) if (row.ppid === found[i]) found.push(row.pid)
  }
  return found
}

/**
 * Stops every CLI recorded by a backend that no longer runs, with the
 * processes it started. Returns how many CLIs it stopped. Synchronous, so it
 * finishes before this backend starts any session.
 */
export function reapOrphanedClaudeChildren(dir: string): number {
  if (process.platform === 'win32') return 0
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('reading claude CLI ledgers failed', err)
    return 0
  }
  const orphaned: Ledger[] = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      const ledger = JSON.parse(readFileSync(file, 'utf8')) as Ledger
      if (isAlive(ledger.ownerPid)) continue
      orphaned.push(ledger)
    } catch (err) {
      log.warn(`unreadable claude CLI ledger ${name}, dropping it`, err)
    }
    rmSync(file, { force: true })
  }
  if (!orphaned.some((ledger) => ledger.children.length > 0)) return 0

  const ps = spawnSync('ps', PS_ARGS, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (ps.status !== 0) {
    log.warn(`ps failed (status ${ps.status}), orphaned claude CLIs not checked`, ps.error ?? ps.stderr)
    return 0
  }
  const rows = parsePs(ps.stdout)
  let reaped = 0
  for (const ledger of orphaned) {
    for (const child of ledger.children) {
      if (!rows.some((row) => row.pid === child.pid && row.command === child.command)) continue
      const pids = descendants(rows, child.pid)
      log.warn(`stopping orphaned claude CLI ${child.pid} of dead backend ${ledger.ownerPid}`, { pids })
      for (const pid of pids) signal(pid, 'SIGTERM')
      setTimeout(() => {
        for (const pid of pids) if (isAlive(pid)) signal(pid, 'SIGKILL')
      }, KILL_GRACE_MS).unref()
      reaped++
    }
  }
  return reaped
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') log.warn(`${sig} to ${pid} failed`, err)
  }
}
