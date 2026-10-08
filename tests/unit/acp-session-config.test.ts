import { describe, expect, it } from 'vitest'
import { acpModeFor, modelsFromConfigOptions, resolveAcpModeIds } from '../../src/main/provider/adapters/acp/session-config'
import { missingCapabilities } from '../../src/main/provider/adapters/acp/acp-adapter'

const modes = (current: string, ids: string[]) => ({ currentModeId: current, availableModes: ids.map((id) => ({ id, name: id })) })

describe('resolveAcpModeIds', () => {
  it('uses fixed ids as given', () => {
    const ids = resolveAcpModeIds({ kind: 'fixed', plan: 'plan', other: 'build' }, null)
    expect(acpModeFor(ids, 'plan')).toBe('plan')
    expect(acpModeFor(ids, 'full-access')).toBe('build')
  })

  it('maps plan to an advertised plan mode and the rest to the starting mode', () => {
    const ids = resolveAcpModeIds({ kind: 'advertised' }, modes('default', ['default', 'Plan', 'yolo']))
    expect(ids).toEqual({ plan: 'Plan', other: 'default' })
  })

  it('has no plan mode to go to when none is advertised, and nothing at all without modes', () => {
    expect(resolveAcpModeIds({ kind: 'advertised' }, modes('act', ['act']))).toEqual({ plan: null, other: 'act' })
    expect(resolveAcpModeIds({ kind: 'advertised' }, null)).toEqual({ plan: null, other: null })
  })

  it('has no mode to leave plan for when the session started in plan', () => {
    expect(resolveAcpModeIds({ kind: 'advertised' }, modes('plan', ['plan', 'act']))).toEqual({ plan: 'plan', other: null })
  })
})

describe('modelsFromConfigOptions', () => {
  it('flattens grouped model options', () => {
    expect(modelsFromConfigOptions([
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
      {
        id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'b',
        options: [{ group: 'g1', name: 'G1', options: [{ value: 'a', name: 'A' }] }, { group: 'g2', name: 'G2', options: [{ value: 'b', name: 'B' }] }],
      },
    ])).toEqual({ configId: 'model', current: 'b', models: [{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }] })
  })

  it('is null without a model option', () => {
    expect(modelsFromConfigOptions(undefined)).toBeNull()
    expect(modelsFromConfigOptions([{ id: 'x', name: 'X', type: 'boolean', currentValue: true }])).toBeNull()
  })
})

describe('missingCapabilities', () => {
  it('lists the expected capabilities initialize did not advertise', () => {
    expect(missingCapabilities({ sessionCapabilities: { resume: {} }, promptCapabilities: { image: false } }, ['resume', 'image', 'fork']))
      .toEqual(['image', 'fork'])
    expect(missingCapabilities(undefined, [])).toEqual([])
  })
})
