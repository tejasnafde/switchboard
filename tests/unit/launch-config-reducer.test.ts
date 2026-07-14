/**
 * Pure reducer for the Settings → Workspaces template-list editor.
 *
 * The Settings UI lets users add / rename / delete configs within
 * a project's workspace.yaml. To keep the UI a thin shell we drive
 * everything through `launchConfigListReducer` and persist the resulting
 * `LaunchConfigFile` via `serializeLaunchConfigFile`.
 *
 * Constraints encoded in the reducer:
 *   - `default` is reserved: cannot be deleted, cannot be renamed away,
 *     cannot have another template renamed onto it (would silently
 *     destroy the existing default).
 *   - `addLaunchConfig` rejects collisions with existing names.
 *   - `renameLaunchConfig` rejects collisions and is a no-op when from===to.
 *   - All actions return a fresh config - the reducer is pure.
 */
import { describe, it, expect } from 'vitest'
import { launchConfigListReducer } from '../../src/renderer/services/launchConfigListReducer'
import type { LaunchConfigFile } from '../../src/shared/launch-config'

const seed: LaunchConfigFile = {
  terminals: [{ label: 'shell' }],
  configs: {
    default: { terminals: [{ label: 'shell' }] },
    backend: { terminals: [{ label: 'api' }] },
  },
}

describe('launchConfigListReducer - addLaunchConfig', () => {
  it('adds a new empty template', () => {
    const next = launchConfigListReducer(seed, { type: 'addLaunchConfig', name: 'monitoring' })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(Object.keys(next.config.configs!).sort()).toEqual(['backend', 'default', 'monitoring'])
    expect(next.config.configs!.monitoring.terminals).toEqual([{ label: 'Terminal 1' }])
  })

  it('rejects an empty name', () => {
    const next = launchConfigListReducer(seed, { type: 'addLaunchConfig', name: '' })
    expect(next.ok).toBe(false)
  })

  it('rejects a collision with an existing template', () => {
    const next = launchConfigListReducer(seed, { type: 'addLaunchConfig', name: 'backend' })
    expect(next.ok).toBe(false)
  })
})

describe('launchConfigListReducer - deleteLaunchConfig', () => {
  it('removes a non-default template', () => {
    const next = launchConfigListReducer(seed, { type: 'deleteLaunchConfig', name: 'backend' })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(Object.keys(next.config.configs!)).toEqual(['default'])
  })

  it('refuses to delete the default template', () => {
    const next = launchConfigListReducer(seed, { type: 'deleteLaunchConfig', name: 'default' })
    expect(next.ok).toBe(false)
  })

  it('is a no-op when the template doesn\'t exist', () => {
    const next = launchConfigListReducer(seed, { type: 'deleteLaunchConfig', name: 'ghost' })
    expect(next.ok).toBe(false)
  })
})

describe('launchConfigListReducer - renameLaunchConfig', () => {
  it('renames a non-default template', () => {
    const next = launchConfigListReducer(seed, { type: 'renameLaunchConfig', from: 'backend', to: 'api' })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(Object.keys(next.config.configs!).sort()).toEqual(['api', 'default'])
    expect(next.config.configs!.api.terminals[0].label).toBe('api')
  })

  it('refuses to rename the default template', () => {
    const next = launchConfigListReducer(seed, { type: 'renameLaunchConfig', from: 'default', to: 'main' })
    expect(next.ok).toBe(false)
  })

  it('refuses to rename onto an existing name', () => {
    const next = launchConfigListReducer(seed, { type: 'renameLaunchConfig', from: 'backend', to: 'default' })
    expect(next.ok).toBe(false)
  })

  it('is a no-op when from===to', () => {
    const next = launchConfigListReducer(seed, { type: 'renameLaunchConfig', from: 'backend', to: 'backend' })
    expect(next.ok).toBe(true)
  })

  it('rejects empty target name', () => {
    const next = launchConfigListReducer(seed, { type: 'renameLaunchConfig', from: 'backend', to: '' })
    expect(next.ok).toBe(false)
  })
})

describe('launchConfigListReducer - replaceLaunchConfigBody', () => {
  it('replaces a template\'s terminals with a fresh body', () => {
    const next = launchConfigListReducer(seed, {
      type: 'replaceLaunchConfigBody',
      name: 'backend',
      body: { terminals: [{ label: 'api2' }, { label: 'db' }] },
    })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.config.configs!.backend.terminals).toHaveLength(2)
    expect(next.config.configs!.backend.terminals[1].label).toBe('db')
  })

  it('refuses to replace a template that doesn\'t exist', () => {
    const next = launchConfigListReducer(seed, {
      type: 'replaceLaunchConfigBody',
      name: 'ghost',
      body: { terminals: [] },
    })
    expect(next.ok).toBe(false)
  })
})
