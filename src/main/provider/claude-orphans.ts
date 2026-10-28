/**
 * A Claude Code CLI outlives the backend that started it: on stdin EOF it
 * still finishes its current turn, tools and all. After a crash or a
 * headless restart, a resumed chat would then put a second agent in the same
 * checkout. Each backend records the CLIs it runs in a ledger file named by
 * its pid, and on start stops the CLIs of every ledger whose backend is gone.
 *
 * A process is known by its pid and start time together, so a reused pid is
 * never taken for the backend or the CLI. A CLI is stopped only when its
 * command line still hashes to the recorded one. The ledger keeps only that
 * hash: the command line carries the Switchboard MCP token.
 */
import { execFile } from 'child_process'
import { createHash } from 'crypto'
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
const POLL_MS = 100
const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,lstart=,command=']

export interface ProcessRow {
  pid: number
  ppid: number
  /** `lstart`, the start time: with the pid, the process's identity. */
  start: string
  command: string
}

interface Identity {
  pid: number
  start: string
}

interface Ledger {
  ownerPid: number
  ownerStart: string
  children: (Identity & { commandHash: string })[]
}

export function claudeOrphanLedgerDir(): string {
  return join(userDataDir(), 'claude-cli-children')
}

export function parsePs(out: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s(.*)$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      start: match[3].replace(/\s+/g, ' '),
      command: match[4].trim(),
    })
  }
  return rows
}

async function listProcesses(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('ps', PS_ARGS, {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  })
  return parsePs(stdout)
}

const hashCommand = (command: string): string => createHash('sha256').update(command).digest('hex')

const running = (rows: ProcessRow[], id: Identity): boolean =>
  rows.some((row) => row.pid === id.pid && row.start === id.start)

/** Writes the CLIs `ownerPid` runs now to its ledger, replacing what it held. */
export async function recordClaudeChildren(dir: string, ownerPid = process.pid): Promise<void> {
  if (process.platform === 'win32') return
  const rows = await listProcesses()
  const owner = rows.find((row) => row.pid === ownerPid)
  if (!owner) throw new Error(`owner ${ownerPid} not in the process list`)
  const ledger: Ledger = {
    ownerPid,
    ownerStart: owner.start,
    children: rows
      .filter((row) => row.ppid === ownerPid && row.command.includes(CLI_MARK))
      .map((row) => ({ pid: row.pid, start: row.start, commandHash: hashCommand(row.command) })),
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${ownerPid}.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify(ledger), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

let recording: Promise<void> = Promise.resolve()

/** Queues a ledger refresh for this process; called once a CLI has started. */
export function noteClaudeChildStarted(): void {
  recording = recording
    .then(() => recordClaudeChildren(claudeOrphanLedgerDir()))
    .catch((err) => log.warn('recording claude CLI children failed', err))
}

function descendants(rows: ProcessRow[], root: ProcessRow): Identity[] {
  const found = [root]
  for (let i = 0; i < found.length; i++) {
    for (const row of rows) if (row.ppid === found[i].pid) found.push(row)
  }
  return found.map(({ pid, start }) => ({ pid, start }))
}

/**
 * Stops every CLI recorded by a backend that no longer runs, with the
 * processes it started, and resolves once they are gone: SIGTERM, then
 * SIGKILL for any still running after `graceMs`. A ledger of this process
 * counts as dead, since this runs before it records anything. Resolves to
 * how many CLIs it stopped.
 */
export async function reapOrphanedClaudeChildren(dir: string, graceMs = KILL_GRACE_MS): Promise<number> {
  if (process.platform === 'win32') return 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('reading claude CLI ledgers failed', err)
    return 0
  }
  if (names.length === 0) return 0
  const rows = await listProcesses()

  const orphaned: Ledger[] = []
  for (const name of names) {
    const file = join(dir, name)
    if (name.endsWith('.json.tmp')) {
      // A write cut short. Its owner, when alive, renames it any moment now.
      const owner = Number.parseInt(name, 10)
      if (owner === process.pid || !rows.some((row) => row.pid === owner)) rmSync(file, { force: true })
      continue
    }
    if (!name.endsWith('.json')) continue
    try {
      const ledger = JSON.parse(readFileSync(file, 'utf8')) as Ledger
      const ownerLive =
        ledger.ownerPid !== process.pid && running(rows, { pid: ledger.ownerPid, start: ledger.ownerStart })
      if (ownerLive) continue
      orphaned.push(ledger)
    } catch (err) {
      log.warn(`unreadable claude CLI ledger ${name}, dropping it`, err)
    }
    rmSync(file, { force: true })
  }

  let reaped = 0
  const targets: Identity[] = []
  for (const ledger of orphaned) {
    for (const child of ledger.children) {
      const row = rows.find(
        (r) => r.pid === child.pid && r.start === child.start && hashCommand(r.command) === child.commandHash,
      )
      if (!row) continue
      const tree = descendants(rows, row)
      log.warn(`stopping orphaned claude CLI ${child.pid} of dead backend ${ledger.ownerPid}`, {
        pids: tree.map((id) => id.pid),
      })
      targets.push(...tree)
      reaped++
    }
  }
  if (targets.length === 0) return reaped

  for (const id of targets) signal(id.pid, 'SIGTERM')
  const deadline = Date.now() + graceMs
  let left = targets
  while (left.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    const now = await listProcesses()
    left = left.filter((id) => running(now, id))
    if (left.length > 0 && Date.now() >= deadline) {
      for (const id of left) signal(id.pid, 'SIGKILL')
      break
    }
  }
  return reaped
}

let reapedAtStart: Promise<number> | null = null

/**
 * The start-up reap, once per process: a registry made again later in this
 * process must not take its own live CLIs for orphans. Never rejects.
 */
export function reapOrphanedClaudeChildrenOnce(): Promise<number> {
  reapedAtStart ??= reapOrphanedClaudeChildren(claudeOrphanLedgerDir()).catch((err) => {
    log.warn('reaping orphaned claude CLIs failed', err)
    return 0
  })
  return reapedAtStart
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') log.warn(`${sig} to ${pid} failed`, err)
  }
}
