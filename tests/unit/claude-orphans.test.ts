/**
 * A Claude Code CLI keeps running its turn after the backend that started it
 * dies: stdin EOF ends the CLI only once the current turn is done. The next
 * backend start must stop such an orphan before it starts a second agent in
 * the same checkout.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordClaudeChildren, reapOrphanedClaudeChildren } from '../../src/main/provider/claude-orphans'

const idle = 'setInterval(() => {}, 1000)'
// Ignores stdin EOF, like the CLI in the middle of a turn, and runs a tool.
const fakeCli = `const t = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); process.stdout.write(String(t.pid)); ${idle}`
const fakeBackend = `
const cli = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(fakeCli)}, '--', '--input-format', 'stream-json'], { stdio: ['pipe', 'pipe', 'ignore'] })
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

function startBackend(): Promise<{ backend: ChildProcess; cli: number; tool: number }> {
  const backend = spawn(process.execPath, ['-e', fakeBackend], { stdio: ['ignore', 'pipe', 'ignore'] })
  procs.push(backend)
  return new Promise((resolve) => {
    backend.stdout!.once('data', (d) => {
      const { cli, tool } = JSON.parse(String(d)) as { cli: number; tool: number }
      pids.push(cli, tool)
      resolve({ backend, cli, tool })
    })
  })
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
    backend.kill('SIGKILL')
    await new Promise((r) => backend.once('exit', r))

    // The gap: nothing stops the CLI when its backend dies.
    expect(await waitFor(() => !alive(cli), 300)).toBe(false)

    expect(reapOrphanedClaudeChildren(dir)).toBe(1)
    expect(await waitFor(() => !alive(cli) && !alive(tool))).toBe(true)
    expect(existsSync(join(dir, `${backend.pid}.json`))).toBe(false)
  })

  it('leaves the CLI of a backend that is still running', async () => {
    const { backend, cli } = await startBackend()
    await recordClaudeChildren(dir, backend.pid!)

    expect(reapOrphanedClaudeChildren(dir)).toBe(0)
    expect(alive(cli)).toBe(true)
    expect(existsSync(join(dir, `${backend.pid}.json`))).toBe(true)
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
        children: [{ pid: other.pid, command: 'claude --input-format stream-json --output-format stream-json' }],
      }),
    )

    expect(reapOrphanedClaudeChildren(dir)).toBe(0)
    expect(alive(other.pid!)).toBe(true)
    expect(existsSync(ledger)).toBe(false)
  })

  it('does nothing without a ledger', () => {
    expect(reapOrphanedClaudeChildren(join(dir, 'missing'))).toBe(0)
  })
})
