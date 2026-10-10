/**
 * Every generic ACP agent (gemini, vibe-acp, cline, copilot) is a global
 * npm/uv install, and on Windows `findAgentBinary` resolves that to a
 * `.cmd`/`.bat` shim (CodeRabbit on PR #302, acp-adapter.ts). Plain
 * `child_process.spawn()` cannot execute a shim without a shell, so the
 * adapter spawns through `cross-spawn` instead, which detects a shim by its
 * extension and launches it through `cmd.exe` itself, with the command and
 * every argument quoted and shell metacharacters escaped (it is a
 * zero-op passthrough to `child_process.spawn` on macOS/Linux, which is why
 * `acp-generic-adapter.test.ts` needs no platform stub).
 *
 * cross-spawn's own escaping is upstream's to test, not ours; what this file
 * owns is that the adapter hands it the resolved binary (whatever
 * `findAgentBinary` returns, `.cmd` shim or not) and the launch args
 * unchanged, on every platform, rather than calling `child_process.spawn`
 * directly, where a Windows shim would fail to start at all.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const WIN_SHIM = 'C:\\Users\\pankaj\\AppData\\Roaming\\npm\\gemini.cmd'

interface FakeState {
  spawns: Array<{ bin: string; args: string[]; options: Record<string, unknown> }>
}

const fake = vi.hoisted(() => ({ state: null as FakeState | null }))

vi.mock('../../src/main/provider/adapters/acp/agent-env', () => ({
  findAgentBinary: () => WIN_SHIM,
  buildAgentEnv: (overlay: Record<string, string>) => ({ ...overlay }),
}))

vi.mock('cross-spawn', () => ({
  default: vi.fn((bin: string, args: string[], options: Record<string, unknown>) => {
    fake.state!.spawns.push({ bin, args, options })
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.kill = vi.fn()
    return child
  }),
}))

beforeEach(() => {
  fake.state = { spawns: [] }
})

describe('generic ACP adapter, Windows .cmd shim launch', () => {
  it('spawns a global npm .cmd shim through cross-spawn, not child_process directly', async () => {
    const { AcpAdapter, ACP_HANDSHAKE_TIMEOUT_MS } = await import('../../src/main/provider/adapters/acp/acp-adapter')
    const { genericAcpLaunchConfig } = await import('../../src/main/provider/adapters/acp/agents')
    const adapter = new AcpAdapter(genericAcpLaunchConfig('gemini'))

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const startPromise = adapter.startSession(
        { threadId: 'chat-1', provider: 'gemini', cwd: 'C:\\Users\\pankaj\\project', runtimeMode: 'sandbox' },
        () => {},
      )
      // Nothing ever answers the handshake on the fake child's stdio (this
      // test only cares about the spawn call); let it time out cleanly
      // rather than hang, the same way acp-generic-adapter.test.ts does.
      const assertion = expect(startPromise).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(ACP_HANDSHAKE_TIMEOUT_MS)
      await assertion
    } finally {
      vi.useRealTimers()
    }

    expect(fake.state!.spawns).toHaveLength(1)
    const [call] = fake.state!.spawns
    // The resolved `.cmd` shim path reaches cross-spawn exactly as
    // `findAgentBinary` returned it - the adapter never second-guesses or
    // rewrites it, and never falls back to `child_process.spawn` itself,
    // which cannot launch a Windows shim without a shell.
    expect(call.bin).toBe(WIN_SHIM)
    expect(call.args).toEqual(['--acp'])
    expect(call.options.cwd).toBe('C:\\Users\\pankaj\\project')
  })
})
