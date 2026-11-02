import { afterEach, describe, expect, it } from 'vitest'
import { readyCapabilities, setFlagCapabilities } from '../../src/main/backend/flag-capabilities'
import { BACKEND_CAPABILITIES } from '../../src/shared/ws-protocol'
import { hubFlagCapabilities } from '../../src/shared/hub'

describe('readyCapabilities', () => {
  afterEach(() => setFlagCapabilities(() => []))

  it('is the fixed set until a flag reader is set', () => {
    expect(readyCapabilities()).toEqual([...BACKEND_CAPABILITIES])
  })

  it('adds what the flag reader answers at each call', () => {
    const env: NodeJS.ProcessEnv = {}
    setFlagCapabilities(() => hubFlagCapabilities(env, () => null))
    expect(readyCapabilities()).not.toContain('hub_children_v1')
    env.SB_HUB_CHILDREN = '1'
    expect(readyCapabilities()).toEqual([...BACKEND_CAPABILITIES, 'hub_children_v1'])
  })

  it('falls back to the fixed set when the reader throws', () => {
    setFlagCapabilities(() => {
      throw new Error('database closed')
    })
    expect(readyCapabilities()).toEqual([...BACKEND_CAPABILITIES])
  })
})
