import { afterEach, describe, expect, it, vi } from 'vitest'
import { delimiter } from 'path'

vi.mock('../../src/main/shell-env', () => ({
  peekShellEnv: () => ({ PATH: '/shell/bin', SHELL_ONLY: '1' }),
}))

const { buildAgentEnv } = await import('../../src/main/provider/adapters/acp/agent-env')

afterEach(() => vi.unstubAllEnvs())

describe('buildAgentEnv', () => {
  it('puts the login shell PATH before the process PATH, and the overlay last', () => {
    vi.stubEnv('PATH', '/usr/bin')
    const env = buildAgentEnv({ API_KEY: 'k' })
    expect(env.PATH).toBe(['/shell/bin', '/usr/bin'].join(delimiter))
    expect(env.SHELL_ONLY).toBe('1')
    expect(env.API_KEY).toBe('k')
    expect(buildAgentEnv({ PATH: '/mine' }).PATH).toBe('/mine')
  })
})
