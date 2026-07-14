/**
 * Pure-logic tests for the workspace-template → terminal-spawn planner.
 *
 * `planLaunchConfigSpawn(template, projectPath)` is the pure function that
 * turns a parsed `LaunchConfig` into a sequence of ops the
 * lifecycle hook will dispatch onto the terminal store. Keeping this
 * logic separate from `useTerminalLifecycle` means we can verify the
 * shape (op order, cwd resolution, on_start mapping, row/column
 * split semantics) without standing up Electron or React.
 *
 * The hook's job at runtime is just: call planLaunchConfigSpawn, walk the
 * ops, and dispatch each to the store. If this function is correct
 * and the store actions are independently correct, the integration is
 * correct.
 */
import { describe, it, expect } from 'vitest'
import { planLaunchConfigSpawn, resolveLaunchConfigFallback } from '../../src/renderer/services/launchConfigPlanner'
import type { LaunchConfigFile, LaunchConfig } from '../../src/shared/launch-config'

describe('planLaunchConfigSpawn - flat terminals', () => {
  it('first terminal becomes addWindow, rest become splitRow (same row)', () => {
    const tpl: LaunchConfig = {
      terminals: [
        { label: 'a', on_start: 'echo a' },
        { label: 'b' },
        { label: 'c' },
      ],
    }
    const ops = planLaunchConfigSpawn(tpl, '/proj')
    expect(ops).toEqual([
      { kind: 'addWindow', opts: { label: 'a', cwd: '/proj', command: 'echo a', wait_for: undefined } },
      { kind: 'splitRow', opts: { label: 'b', cwd: '/proj', command: undefined, wait_for: undefined } },
      { kind: 'splitRow', opts: { label: 'c', cwd: '/proj', command: undefined, wait_for: undefined } },
    ])
  })

  it('resolves relative cwd against projectPath', () => {
    const tpl: LaunchConfig = {
      terminals: [{ label: 'api', cwd: 'services/api' }],
    }
    const ops = planLaunchConfigSpawn(tpl, '/proj')
    expect(ops[0].opts.cwd).toBe('/proj/services/api')
  })

  it('passes through absolute cwd unchanged', () => {
    const tpl: LaunchConfig = {
      terminals: [{ label: 'log', cwd: '/var/log' }],
    }
    const ops = planLaunchConfigSpawn(tpl, '/proj')
    expect(ops[0].opts.cwd).toBe('/var/log')
  })

  it('falls back to projectPath when cwd is undefined', () => {
    const tpl: LaunchConfig = { terminals: [{ label: 'shell' }] }
    expect(planLaunchConfigSpawn(tpl, '/proj')[0].opts.cwd).toBe('/proj')
  })
})

describe('planLaunchConfigSpawn - rows layout', () => {
  it('first pane addWindow, additional panes in row 0 splitRow, new rows splitColumn', () => {
    const tpl: LaunchConfig = {
      terminals: [],
      rows: [
        { panes: [{ label: 'top-left' }, { label: 'top-right' }] },
        { panes: [{ label: 'bottom-only' }] },
      ],
    }
    const ops = planLaunchConfigSpawn(tpl, '/proj')
    expect(ops.map((o) => o.kind)).toEqual(['addWindow', 'splitRow', 'splitColumn'])
    expect(ops.map((o) => o.opts.label)).toEqual(['top-left', 'top-right', 'bottom-only'])
  })

  it('skips empty row panes', () => {
    const tpl: LaunchConfig = {
      terminals: [],
      rows: [
        { panes: [{ label: 'a' }] },
        { panes: [] },
        { panes: [{ label: 'b' }] },
      ],
    }
    const ops = planLaunchConfigSpawn(tpl, '/proj')
    expect(ops.map((o) => o.opts.label)).toEqual(['a', 'b'])
  })

  it('emits a default single-pane op when template is fully empty', () => {
    const tpl: LaunchConfig = { terminals: [] }
    const ops = planLaunchConfigSpawn(tpl, '/proj')
    expect(ops).toEqual([
      { kind: 'addWindow', opts: { label: 'Terminal 1', cwd: '/proj', command: undefined, wait_for: undefined } },
    ])
  })
})

describe('resolveLaunchConfigFallback - hot reload edge cases', () => {
  const config: LaunchConfigFile = {
    terminals: [{ label: 'shell' }],
    configs: {
      default: { terminals: [{ label: 'shell' }] },
      backend: { terminals: [{ label: 'api' }] },
    },
  }

  it('returns the requested template when it exists', () => {
    const result = resolveLaunchConfigFallback(config, 'backend')
    expect(result.launchConfigName).toBe('backend')
    expect(result.fellBack).toBe(false)
    expect(result.launchConfig.terminals[0].label).toBe('api')
  })

  it('falls back to default when the requested name is missing', () => {
    const result = resolveLaunchConfigFallback(config, 'monitoring')
    expect(result.launchConfigName).toBe('default')
    expect(result.fellBack).toBe(true)
    expect(result.removedName).toBe('monitoring')
  })

  it('returns default when no name is requested', () => {
    const result = resolveLaunchConfigFallback(config, null)
    expect(result.launchConfigName).toBe('default')
    expect(result.fellBack).toBe(false)
  })

  it('returns null when neither requested nor default exists', () => {
    const empty: LaunchConfigFile = { terminals: [], configs: {} }
    expect(resolveLaunchConfigFallback(empty, null)).toBeNull()
    expect(resolveLaunchConfigFallback(empty, 'anything')).toBeNull()
  })
})
