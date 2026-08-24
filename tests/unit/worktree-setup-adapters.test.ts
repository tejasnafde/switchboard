import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETUP_TIMEOUT_MS,
  LaunchConfigWorktreeSetupConfig,
  ProcessWorktreeSetupRunner,
} from '../../src/main/worktree-creation/setup-adapters'

describe('worktree setup host adapters', () => {
  it('loads only the additive worktree setup section from checked-in launch config', async () => {
    const read = vi.fn(async () => `
worktree:
  setup:
    command: "npm ci"
    default_policy: run
    startup_policy: wait-for-setup
configs:
  default:
    terminals: []
`)
    const loader = new LaunchConfigWorktreeSetupConfig(read)

    await expect(loader.load('/managed/repo')).resolves.toEqual({
      command: 'npm ci',
      defaultPolicy: 'run',
      startupPolicy: 'wait-for-setup',
    })
    expect(read).toHaveBeenCalledWith('/managed/repo')
  })

  it('returns undefined for an absent file and rejects malformed setup policy', async () => {
    await expect(new LaunchConfigWorktreeSetupConfig(async () => null).load('/repo'))
      .resolves.toBeUndefined()
    await expect(new LaunchConfigWorktreeSetupConfig(async () => `
worktree:
  setup:
    command: npm ci
    default_policy: sometimes
`).load('/repo')).rejects.toThrow(/default_policy/i)
  })

  it('executes the explicit command in the worktree cwd without exposing it in its result', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0 }))
    const runner = new ProcessWorktreeSetupRunner(execute)

    const result = await runner.run({
      creationId: 'creation-secret-safe',
      cwd: '/managed/repo',
      command: './script --token secret-value',
    })

    expect(execute).toHaveBeenCalledWith({
      cwd: '/managed/repo',
      command: './script --token secret-value',
      signal: expect.any(AbortSignal),
    })
    expect(result).toEqual({ kind: 'succeeded', exitCode: 0 })
    expect(JSON.stringify(result)).not.toContain('secret-value')
  })

  it('classifies a non-zero exit as definite setup failure', async () => {
    const runner = new ProcessWorktreeSetupRunner(async () => ({ exitCode: 17 }))
    await expect(runner.run({ creationId: 'creation-1', cwd: '/repo', command: 'false' }))
      .resolves.toEqual({ kind: 'failed', exitCode: 17 })
  })

  it('uses a conservative production timeout and classifies expiry as ambiguous', async () => {
    expect(DEFAULT_SETUP_TIMEOUT_MS).toBe(30 * 60 * 1_000)
    const execute = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<{ exitCode: number }>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const runner = new ProcessWorktreeSetupRunner(execute, 10)

    const result = await runner.run({
      creationId: 'creation-timeout',
      cwd: '/managed/repo',
      command: './script --token secret-timeout-value',
    })

    expect(result).toEqual({ kind: 'outcome_unknown' })
    expect(JSON.stringify(result)).not.toContain('secret-timeout-value')
    expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(true)
  })

  it('cancels setup through a caller signal and keeps the outcome secret-free', async () => {
    const execute = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<{ exitCode: number }>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const runner = new ProcessWorktreeSetupRunner(execute)
    const controller = new AbortController()
    const pending = runner.run({
      creationId: 'creation-cancelled',
      cwd: '/managed/repo',
      command: './script --token secret-cancelled-value',
      signal: controller.signal,
    })

    controller.abort()

    const result = await pending
    expect(result).toEqual({ kind: 'outcome_unknown' })
    expect(JSON.stringify(result)).not.toContain('secret-cancelled-value')
  })
})
