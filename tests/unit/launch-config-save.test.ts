import { describe, expect, it } from 'vitest'
import { saveLaunchConfigFor } from '../../src/renderer/components/settings/launch-config-save'
import type { LaunchConfigFile } from '../../src/shared/launch-config'

const config: LaunchConfigFile = { terminals: [], configs: { default: { terminals: [] } } }

describe('saveLaunchConfigFor', () => {
  it('writes to the project it was given and reports saved', async () => {
    const writes: string[] = []
    const outcome = await saveLaunchConfigFor('/a', config, async (p) => { writes.push(p) }, () => true)
    expect(outcome).toEqual({ kind: 'saved' })
    expect(writes).toEqual(['/a'])
  })

  it('reports a failed write, so the caller keeps the edit unsaved', async () => {
    const outcome = await saveLaunchConfigFor('/a', config, async () => { throw new Error('EACCES') }, () => true)
    expect(outcome).toEqual({ kind: 'failed', error: 'EACCES' })
  })

  it('is stale when the project changed while the write was in flight', async () => {
    let current = '/a'
    const outcome = await saveLaunchConfigFor('/a', config, async () => { current = '/b' }, (p) => p === current)
    expect(outcome).toEqual({ kind: 'stale' })
  })

  it('does not report a stale failure against the project now shown', async () => {
    let current = '/a'
    const outcome = await saveLaunchConfigFor('/a', config, async () => { current = '/b'; throw new Error('boom') }, (p) => p === current)
    expect(outcome).toEqual({ kind: 'stale' })
  })
})
