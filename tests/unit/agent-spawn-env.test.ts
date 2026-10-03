import { describe, expect, it } from 'vitest'
import { backgroundByDefault, markAgentSpawnEnv } from '../../src/main/provider/agent-spawn-env'

describe('agent spawn env', () => {
  it('marks an agent env without touching the input', () => {
    const base = { PATH: '/bin' }
    expect(markAgentSpawnEnv(base)).toEqual({ PATH: '/bin', SWITCHBOARD_AGENT: '1' })
    expect(base).toEqual({ PATH: '/bin' })
  })

  it('opens in the background when an agent launched it, unless told otherwise', () => {
    expect(backgroundByDefault({})).toBe(false)
    expect(backgroundByDefault({ CLAUDECODE: '1' })).toBe(true)
    expect(backgroundByDefault({ SWITCHBOARD_AGENT: '1' })).toBe(true)
    expect(backgroundByDefault({ SWITCHBOARD_AGENT: '1', SB_E2E_BACKGROUND: '0' })).toBe(false)
    expect(backgroundByDefault({ SB_E2E_BACKGROUND: '1' })).toBe(true)
  })
})
