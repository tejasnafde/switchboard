/**
 * A Claude Code CLI keeps running its turn after the backend that started it
 * dies: stdin EOF ends the CLI only once the current turn is done. The next
 * backend start must stop such an orphan before it starts a second agent in
 * the same checkout.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePs, recordClaudeChildren, reapOrphanedClaudeChildren } from '../../src/main/provider/claude-orphans'

const idle = 'setInterval(() => {}, 1000)'
// Ignores stdin EOF, like the CLI in the middle of a turn, and runs a tool.
const fakeCli = (prelude = '') =>
  `${prelude}; const t = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); process.stdout.write(String(t.pid)); ${idle}`
const cliArgs = (prelude?: string) => ['-e', fakeCli(prelude), '--', '--input-format', 'stream-json']
const fakeBackend = (prelude?: string) => `
const cli = require('child_process').spawn(process.execPath, ${JSON.stringify(cliArgs(prelude))}, { stdio: ['pipe', 'pipe', 'ignore'] })
cli.stdout.once('data', (d) => process.stdout.write(JSON.stringify({ cli: cli.pid, tool: Number(String(d)) }) + '\\n'))
${idle}`

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

let dir: string
const pids: number[] = []
const procs: ChildProcess[] = []
const GRACE_MS = 500

/** Resolves with the first line `proc` prints, or rejects after 5 s. */
function firstLine(proc: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no output within 5 s')), 5_000)
    proc.stdout!.once('data', (d) => {
      clearTimeout(timer)
      resolve(String(d))
    })
  })
}

async function startBackend(cliPrelude?: string): Promise<{ backend: ChildProcess; cli: number; tool: number }> {
  const backend = spawn(process.execPath, ['-e', fakeBackend(cliPrelude)], { stdio: ['ignore', 'pipe', 'ignore'] })
  procs.push(backend)
  const { cli, tool } = JSON.parse(await firstLine(backend)) as { cli: number; tool: number }
  pids.push(cli, tool)
  return { backend, cli, tool }
}

async function killBackend(backend: ChildProcess): Promise<void> {
  const exited = new Promise((r) => backend.once('exit', r))
  backend.kill('SIGKILL')
  await exited
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-claude-orphans-'))
})

afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL')
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('claude orphans', () => {
  it('stops the CLI and its tools after the backend that started it died', async () => {
    const { backend, cli, tool } = await startBackend()
    await recordClaudeChildren(dir, backend.pid!)
    await killBackend(backend)

    // The gap: nothing stops the CLI when its backend dies.
    expect(await waitFor(() => !alive(cli), 300)).toBe(false)

    expect(await reapOrphanedClaudeChildren(dir, GRACE_MS)).toBe(1)
    expect(alive(cli) || alive(tool)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('kills a CLI that ignores SIGTERM once the grace time is over', async () => {
    const { backend, cli } = await startBackend("process.on('SIGTERM', () => {})")
    await recordClaudeChildren(dir, backend.pid!)
    await killBackend(backend)

    expect(await reapOrphanedClaudeChildren(dir, GRACE_MS)).toBe(1)
    expect(await waitFor(() => !alive(cli), 1000)).toBe(true)
  })

  it('leaves the CLI of a backend that is still running', async () => {
    const { backend, cli } = await startBackend()
    await recordClaudeChildren(dir, backend.pid!)

    expect(await reapOrphanedClaudeChildren(dir, GRACE_MS)).toBe(0)
    expect(alive(cli)).toBe(true)
    expect(existsSync(join(dir, `${backend.pid}.json`))).toBe(true)
  })

  it('treats a ledger of this process as left by an earlier backend with the same pid', async () => {
    const cli = spawn(process.execPath, cliArgs(), { stdio: ['pipe', 'pipe', 'ignore'] })
    procs.push(cli)
    const tool = Number(await firstLine(cli))
    pids.push(tool)
    await recordClaudeChildren(dir)

    expect(await reapOrphanedClaudeChildren(dir, GRACE_MS)).toBe(1)
    expect(alive(cli.pid!) || alive(tool)).toBe(false)
  })

  it('does not kill a process that reused a recorded pid', async () => {
    const other = spawn(process.execPath, ['-e', idle], { stdio: 'ignore' })
    procs.push(other)
    const deadOwner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise((r) => deadOwner.once('exit', r))
    const ledger = join(dir, `${deadOwner.pid}.json`)
    writeFileSync(
      ledger,
      JSON.stringify({
        ownerPid: deadOwner.pid,
        ownerStart: 'Thu Jan 1 00:00:00 1970',
        children: [{ pid: other.pid, start: 'Thu Jan 1 00:00:00 1970', commandHash: 'x' }],
      }),
    )

    expect(await reapOrphanedClaudeChildren(dir, GRACE_MS)).toBe(0)
    expect(alive(other.pid!)).toBe(true)
    expect(existsSync(ledger)).toBe(false)
  })

  it('removes the temporary file of a write a dead backend never finished', async () => {
    const deadOwner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise((r) => deadOwner.once('exit', r))
    writeFileSync(join(dir, `${deadOwner.pid}.json.tmp`), '{')
    writeFileSync(join(dir, `${process.ppid}.json.tmp`), '{')

    await reapOrphanedClaudeChildren(dir, GRACE_MS)
    expect(readdirSync(dir)).toEqual([`${process.ppid}.json.tmp`])
  })

  it('writes the ledger for the owner only, without the command line', async () => {
    const { backend } = await startBackend()
    await recordClaudeChildren(dir, backend.pid!)
    const file = join(dir, `${backend.pid}.json`)

    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).not.toContain('stream-json')
  })

  it('does nothing without a ledger', async () => {
    expect(await reapOrphanedClaudeChildren(join(dir, 'missing'), GRACE_MS)).toBe(0)
  })
})

describe('parsePs', () => {
  it('reads macOS and Linux procps rows', () => {
    const out = [
      '  412     1 Wed Oct 28 18:55:01 2026     /usr/local/bin/claude -p --input-format stream-json',
      '    7   412 Thu Oct  8 09:03:44 2026 /bin/sh -c sleep 30',
      'garbage',
      '',
    ].join('\n')

    expect(parsePs(out)).toEqual([
      {
        pid: 412,
        ppid: 1,
        start: 'Wed Oct 28 18:55:01 2026',
        command: '/usr/local/bin/claude -p --input-format stream-json',
      },
      { pid: 7, ppid: 412, start: 'Thu Oct 8 09:03:44 2026', command: '/bin/sh -c sleep 30' },
    ])
  })
})
