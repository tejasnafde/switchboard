/**
 * Pure reducer for the Settings → Workspaces template-list editor.
 *
 * The Settings UI lets users add / rename / delete templates within
 * a project's workspace.yaml. To keep the UI a thin shell we drive
 * everything through `templateListReducer` and persist the resulting
 * `WorkspaceConfig` via `serializeWorkspaceConfig`.
 *
 * Constraints encoded in the reducer:
 *   - `default` is reserved: cannot be deleted, cannot be renamed away,
 *     cannot have another template renamed onto it (would silently
 *     destroy the existing default).
 *   - `addTemplate` rejects collisions with existing names.
 *   - `renameTemplate` rejects collisions and is a no-op when from===to.
 *   - All actions return a fresh config — the reducer is pure.
 */
import { describe, it, expect } from 'vitest'
import { templateListReducer } from '../../src/renderer/services/templateListReducer'
import type { WorkspaceConfig } from '../../src/shared/workspace-config'

const seed: WorkspaceConfig = {
  terminals: [{ label: 'shell' }],
  templates: {
    default: { terminals: [{ label: 'shell' }] },
    backend: { terminals: [{ label: 'api' }] },
  },
}

describe('templateListReducer — addTemplate', () => {
  it('adds a new empty template', () => {
    const next = templateListReducer(seed, { type: 'addTemplate', name: 'monitoring' })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(Object.keys(next.config.templates!).sort()).toEqual(['backend', 'default', 'monitoring'])
    expect(next.config.templates!.monitoring.terminals).toEqual([{ label: 'Terminal 1' }])
  })

  it('rejects an empty name', () => {
    const next = templateListReducer(seed, { type: 'addTemplate', name: '' })
    expect(next.ok).toBe(false)
  })

  it('rejects a collision with an existing template', () => {
    const next = templateListReducer(seed, { type: 'addTemplate', name: 'backend' })
    expect(next.ok).toBe(false)
  })
})

describe('templateListReducer — deleteTemplate', () => {
  it('removes a non-default template', () => {
    const next = templateListReducer(seed, { type: 'deleteTemplate', name: 'backend' })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(Object.keys(next.config.templates!)).toEqual(['default'])
  })

  it('refuses to delete the default template', () => {
    const next = templateListReducer(seed, { type: 'deleteTemplate', name: 'default' })
    expect(next.ok).toBe(false)
  })

  it('is a no-op when the template doesn\'t exist', () => {
    const next = templateListReducer(seed, { type: 'deleteTemplate', name: 'ghost' })
    expect(next.ok).toBe(false)
  })
})

describe('templateListReducer — renameTemplate', () => {
  it('renames a non-default template', () => {
    const next = templateListReducer(seed, { type: 'renameTemplate', from: 'backend', to: 'api' })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(Object.keys(next.config.templates!).sort()).toEqual(['api', 'default'])
    expect(next.config.templates!.api.terminals[0].label).toBe('api')
  })

  it('refuses to rename the default template', () => {
    const next = templateListReducer(seed, { type: 'renameTemplate', from: 'default', to: 'main' })
    expect(next.ok).toBe(false)
  })

  it('refuses to rename onto an existing name', () => {
    const next = templateListReducer(seed, { type: 'renameTemplate', from: 'backend', to: 'default' })
    expect(next.ok).toBe(false)
  })

  it('is a no-op when from===to', () => {
    const next = templateListReducer(seed, { type: 'renameTemplate', from: 'backend', to: 'backend' })
    expect(next.ok).toBe(true)
  })

  it('rejects empty target name', () => {
    const next = templateListReducer(seed, { type: 'renameTemplate', from: 'backend', to: '' })
    expect(next.ok).toBe(false)
  })
})

describe('templateListReducer — replaceTemplateBody', () => {
  it('replaces a template\'s terminals with a fresh body', () => {
    const next = templateListReducer(seed, {
      type: 'replaceTemplateBody',
      name: 'backend',
      body: { terminals: [{ label: 'api2' }, { label: 'db' }] },
    })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.config.templates!.backend.terminals).toHaveLength(2)
    expect(next.config.templates!.backend.terminals[1].label).toBe('db')
  })

  it('refuses to replace a template that doesn\'t exist', () => {
    const next = templateListReducer(seed, {
      type: 'replaceTemplateBody',
      name: 'ghost',
      body: { terminals: [] },
    })
    expect(next.ok).toBe(false)
  })
})
