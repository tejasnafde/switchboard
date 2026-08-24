import { describe, expect, it } from 'vitest'
import {
  parseLaunchConfigFile,
  serializeLaunchConfigFile,
  type LaunchConfigFile,
} from '../../src/shared/launch-config'
import { launchConfigListReducer } from '../../src/renderer/services/launchConfigListReducer'

describe('repository worktree setup launch config', () => {
  it('parses setup independently from terminal on_start commands', () => {
    const parsed = parseLaunchConfigFile(`
worktree:
  setup:
    command: npm ci
    default_policy: ask
    startup_policy: wait-for-setup
terminals:
  - label: Dev server
    on_start: npm run dev
`)

    expect(parsed.worktree).toEqual({
      setup: {
        command: 'npm ci',
        defaultPolicy: 'ask',
        startupPolicy: 'wait-for-setup',
      },
    })
    expect(parsed.terminals[0]?.on_start).toBe('npm run dev')
  })

  it('round-trips setup alongside named launch configs', () => {
    const config: LaunchConfigFile = {
      terminals: [],
      configs: {
        default: { terminals: [{ label: 'Shell' }] },
        tests: { terminals: [{ label: 'Tests', on_start: 'npm test' }] },
      },
      worktree: {
        setup: {
          command: 'pnpm install --frozen-lockfile',
          defaultPolicy: 'run',
          startupPolicy: 'start-immediately',
        },
      },
    }

    const reparsed = parseLaunchConfigFile(serializeLaunchConfigFile(config))
    expect(reparsed.worktree).toEqual(config.worktree)
    expect(reparsed.configs).toEqual({
      default: { terminals: [{ label: 'Shell', cwd: undefined, on_start: undefined, wait_for: undefined }] },
      tests: {
        terminals: [{ label: 'Tests', cwd: undefined, on_start: 'npm test', wait_for: undefined }],
      },
    })
  })

  it.each([
    ['sometimes', 'default_policy'],
    ['eventually', 'startup_policy'],
  ])('rejects invalid %s policy with an actionable field name', (invalid, field) => {
    const yaml = field === 'default_policy'
      ? `worktree:\n  setup:\n    default_policy: ${invalid}\n`
      : `worktree:\n  setup:\n    startup_policy: ${invalid}\n`

    expect(() => parseLaunchConfigFile(yaml)).toThrow(new RegExp(field))
  })

  it('preserves setup when Settings edits a named terminal layout', () => {
    const config = parseLaunchConfigFile(`
worktree:
  setup:
    command: npm ci
    default_policy: skip
    startup_policy: wait-for-setup
configs:
  default:
    terminals:
      - label: Shell
`)

    const result = launchConfigListReducer(config, {
      type: 'replaceLaunchConfigBody',
      name: 'default',
      body: { terminals: [{ label: 'Development', on_start: 'npm run dev' }] },
    })

    expect(result).toMatchObject({
      ok: true,
      config: { worktree: config.worktree },
    })
    if (!result.ok) throw new Error(result.error)
    expect(parseLaunchConfigFile(serializeLaunchConfigFile(result.config)).worktree).toEqual(config.worktree)
  })

  it('updates setup without changing named terminal layouts', () => {
    const config = parseLaunchConfigFile(`
configs:
  default:
    terminals:
      - label: Shell
  tests:
    terminals:
      - label: Tests
`)

    const result = launchConfigListReducer(config, {
      type: 'replaceWorktreeSetup',
      setup: {
        command: 'npm ci',
        defaultPolicy: 'run',
        startupPolicy: 'start-immediately',
      },
    })

    expect(result).toMatchObject({
      ok: true,
      config: {
        configs: config.configs,
        worktree: {
          setup: {
            command: 'npm ci',
            defaultPolicy: 'run',
            startupPolicy: 'start-immediately',
          },
        },
      },
    })
  })
})
