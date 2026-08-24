import { describe, expect, it, vi } from 'vitest'
import {
  ProviderWorktreeStartupLauncher,
  WorktreeLaunchConfigTerminalProvisioner,
} from '../../src/main/worktree-creation/startup-launcher'
import { ManagedTerminalRuntime } from '../../src/main/terminal/managed-terminal-runtime'

function input(prompt?: string) {
  return {
    creationId: 'creation-startup-1',
    projectPath: '/repo',
    worktreePath: '/managed/repo',
    branch: 'sb/startup',
    conversationId: 'conversation-startup-1',
    initialPromptOrigin: 'creation-startup-1:initial-prompt',
    launch: {
      initialAgent: {
        provider: 'claude-code' as const,
        instanceId: 'claude-work',
        model: 'claude-sonnet',
        runtimeMode: 'plan' as const,
        ...(prompt ? { prompt } : {}),
      },
    },
  }
}

describe('ProviderWorktreeStartupLauncher', () => {
  it('starts the provider in the worktree then atomically submits the stable initial prompt', async () => {
    const calls: string[] = []
    const registry = {
      startManagedSession: vi.fn(async () => {
        calls.push('start')
        return { threadId: 'conversation-startup-1' }
      }),
      submitManagedUserTurn: vi.fn(async () => {
        calls.push('prompt')
        return {
          status: 'accepted' as const,
          accepted: true as const,
          duplicate: false,
          state: 'completed' as const,
          acceptedAt: 100,
        }
      }),
    }
    const launcher = new ProviderWorktreeStartupLauncher(() => registry)

    await expect(launcher.launch(input('Begin work.'))).resolves.toEqual({
      status: 'succeeded',
      terminalIds: [],
      providerThreadId: 'conversation-startup-1',
      initialPromptOrigin: 'creation-startup-1:initial-prompt',
    })
    expect(calls).toEqual(['start', 'prompt'])
    expect(registry.startManagedSession).toHaveBeenCalledWith({
      threadId: 'conversation-startup-1',
      provider: 'claude',
      cwd: '/managed/repo',
      instanceId: 'claude-work',
      model: 'claude-sonnet',
      runtimeMode: 'plan',
    })
    expect(registry.submitManagedUserTurn).toHaveBeenCalledWith({
      version: 1,
      threadId: 'conversation-startup-1',
      origin: 'creation-startup-1:initial-prompt',
      providerText: 'Begin work.',
      displayBody: 'Begin work.',
      runtimeMode: 'plan',
    })
  })

  it('does not synthesize or submit a prompt when none was requested', async () => {
    const registry = {
      startManagedSession: vi.fn(async () => ({ threadId: 'conversation-startup-1' })),
      submitManagedUserTurn: vi.fn(),
    }
    const launcher = new ProviderWorktreeStartupLauncher(() => registry)

    const receipt = await launcher.launch(input())

    expect(receipt).toMatchObject({ status: 'succeeded', providerThreadId: 'conversation-startup-1' })
    expect(receipt.initialPromptOrigin).toBeUndefined()
    expect(registry.submitManagedUserTurn).not.toHaveBeenCalled()
  })

  it('starts the initial agent without reading launch config or provisioning a PTY when terminals are forbidden', async () => {
    const registry = {
      startManagedSession: vi.fn(async () => ({ threadId: 'conversation-startup-1' })),
      submitManagedUserTurn: vi.fn(async () => ({
        status: 'accepted' as const,
        accepted: true as const,
        duplicate: false,
        state: 'completed' as const,
        acceptedAt: 100,
      })),
    }
    const terminals = { provision: vi.fn() }
    const launcher = new ProviderWorktreeStartupLauncher(() => registry, terminals)
    const launchInput = input('Start once.')
    launchInput.launch.terminalPolicy = 'skip'

    await expect(launcher.launch(launchInput)).resolves.toMatchObject({
      status: 'succeeded',
      terminalIds: [],
      providerThreadId: 'conversation-startup-1',
    })
    expect(terminals.provision).not.toHaveBeenCalled()
    expect(registry.startManagedSession).toHaveBeenCalledOnce()
    expect(registry.submitManagedUserTurn).toHaveBeenCalledOnce()
  })

  it('keeps an ambiguous atomic prompt outcome ambiguous for same-origin reconciliation', async () => {
    const registry = {
      startManagedSession: vi.fn(async () => ({ threadId: 'conversation-startup-1' })),
      submitManagedUserTurn: vi.fn(async () => ({
        status: 'ambiguous' as const,
        accepted: false as const,
        duplicate: false,
        state: 'ambiguous' as const,
        reason: 'connection lost after dispatch',
      })),
    }
    const launcher = new ProviderWorktreeStartupLauncher(() => registry)

    await expect(launcher.launch(input('Begin work.'))).resolves.toEqual({
      status: 'ambiguous',
      terminalIds: [],
      providerThreadId: 'conversation-startup-1',
      initialPromptOrigin: 'creation-startup-1:initial-prompt',
    })
  })

  it('keeps a thrown prompt submission ambiguous and retries with the same idempotency origin', async () => {
    const registry = {
      startManagedSession: vi.fn(async () => ({ threadId: 'conversation-startup-1' })),
      submitManagedUserTurn: vi.fn()
        .mockRejectedValueOnce(new Error('transport closed after dispatch'))
        .mockResolvedValueOnce({
          status: 'accepted' as const,
          accepted: true as const,
          duplicate: true,
          state: 'completed' as const,
          acceptedAt: 100,
        }),
    }
    const launcher = new ProviderWorktreeStartupLauncher(() => registry)

    await expect(launcher.launch(input('Begin once.'))).resolves.toEqual({
      status: 'ambiguous',
      terminalIds: [],
      providerThreadId: 'conversation-startup-1',
      initialPromptOrigin: 'creation-startup-1:initial-prompt',
    })
    await expect(launcher.launch(input('Begin once.'))).resolves.toEqual({
      status: 'succeeded',
      terminalIds: [],
      providerThreadId: 'conversation-startup-1',
      initialPromptOrigin: 'creation-startup-1:initial-prompt',
    })

    expect(registry.submitManagedUserTurn).toHaveBeenCalledTimes(2)
    expect(registry.submitManagedUserTurn.mock.calls[0][0]).toEqual(
      registry.submitManagedUserTurn.mock.calls[1][0],
    )
    expect(registry.submitManagedUserTurn.mock.calls[0][0]).toMatchObject({
      origin: 'creation-startup-1:initial-prompt',
      providerText: 'Begin once.',
    })
  })

  it('keeps a definite provider session startup rejection failed before prompt dispatch', async () => {
    const registry = {
      startManagedSession: vi.fn(async () => { throw new Error('provider executable unavailable') }),
      submitManagedUserTurn: vi.fn(),
    }
    const launcher = new ProviderWorktreeStartupLauncher(() => registry)

    await expect(launcher.launch(input('Never dispatched.'))).resolves.toEqual({
      status: 'failed',
      terminalIds: [],
    })
    expect(registry.submitManagedUserTurn).not.toHaveBeenCalled()
  })

  it('provisions the selected launch config from the authoritative worktree root', async () => {
    const live = new Set<string>()
    const create = vi.fn(async (options: { id: string }) => { live.add(options.id) })
    const readConfig = vi.fn(() => `
configs:
  default:
    terminals:
      - label: Default
        on_start: default-command
  development:
    rows:
      - panes:
          - label: Server
            cwd: apps/server
            on_start: private-server-command
          - label: Logs
            cwd: .
      - panes:
          - label: Tests
            cwd: tests
            wait_for: ready
            on_start: private-test-command
`)
    const terminals = new WorktreeLaunchConfigTerminalProvisioner(
      readConfig,
      new ManagedTerminalRuntime(() => ({ has: (id) => live.has(id), create })),
    )
    const registry = {
      startManagedSession: vi.fn(async () => ({ threadId: 'conversation-startup-1' })),
      submitManagedUserTurn: vi.fn(),
    }
    const launcher = new ProviderWorktreeStartupLauncher(() => registry, terminals)
    const launchInput = input()
    launchInput.launch.launchConfigName = 'development'

    const receipt = await launcher.launch(launchInput)

    expect(readConfig).toHaveBeenCalledWith('/repo')
    expect(create).toHaveBeenCalledTimes(3)
    expect(create.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ cwd: '/managed/repo/apps/server', initialCommand: 'private-server-command' }),
      expect.objectContaining({ cwd: '/managed/repo' }),
      expect.objectContaining({ cwd: '/managed/repo/tests', initialCommand: 'private-test-command', waitFor: 'ready' }),
    ])
    expect(receipt.status).toBe('succeeded')
    expect(receipt.terminalIds).toHaveLength(3)
    expect(new Set(receipt.terminalIds).size).toBe(3)
    expect(JSON.stringify(receipt)).not.toContain('private-')
  })

  it('falls back to the default config and gives a startup command its own stable handle', async () => {
    const live = new Set<string>()
    const create = vi.fn(async (options: { id: string }) => { live.add(options.id) })
    const terminals = new WorktreeLaunchConfigTerminalProvisioner(
      () => `terminals:\n  - label: Shell\n    on_start: private-default-command\n`,
      new ManagedTerminalRuntime(() => ({ has: (id) => live.has(id), create })),
    )
    const launcher = new ProviderWorktreeStartupLauncher(
      () => null,
      terminals,
    )
    const launchInput = input()
    launchInput.launch.launchConfigName = 'missing-config'
    launchInput.launch.startupCommand = 'private-bootstrap-command'
    delete launchInput.launch.initialAgent

    const first = await launcher.launch(launchInput)
    const second = await launcher.launch(launchInput)

    expect(first).toEqual(second)
    expect(first).toMatchObject({ status: 'succeeded' })
    expect(first.terminalIds).toHaveLength(2)
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0][0]).toMatchObject({
      cwd: '/managed/repo',
      initialCommand: 'private-default-command',
    })
    expect(create.mock.calls[1][0]).toMatchObject({
      cwd: '/managed/repo',
      initialCommand: 'private-bootstrap-command',
    })
  })

  it('rejects a launch-config cwd that escapes the authoritative worktree', async () => {
    const create = vi.fn()
    const terminals = new WorktreeLaunchConfigTerminalProvisioner(
      () => `terminals:\n  - label: Escape\n    cwd: ../outside\n`,
      new ManagedTerminalRuntime(() => ({ has: () => false, create })),
    )
    const launcher = new ProviderWorktreeStartupLauncher(() => null, terminals)
    const launchInput = input()
    delete launchInput.launch.initialAgent

    await expect(launcher.launch(launchInput)).resolves.toEqual({
      status: 'failed',
      terminalIds: [],
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps the requested provider as the initial agent when terminals are also provisioned', async () => {
    const registry = {
      startManagedSession: vi.fn(async () => ({ threadId: 'conversation-startup-1' })),
      submitManagedUserTurn: vi.fn(),
    }
    const terminals = { provision: vi.fn(async () => ({ status: 'succeeded' as const, terminalIds: ['terminal-1'] })) }
    const launcher = new ProviderWorktreeStartupLauncher(() => registry, terminals)
    const launchInput = input()
    launchInput.launch.initialAgent!.provider = 'codex'

    await expect(launcher.launch(launchInput)).resolves.toMatchObject({
      status: 'succeeded',
      terminalIds: ['terminal-1'],
    })
    expect(registry.startManagedSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      cwd: '/managed/repo',
    }))
  })
})
