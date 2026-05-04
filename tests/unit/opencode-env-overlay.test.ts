/**
 * buildOpencodeEnv overlay precedence:
 *   shell-env < process.env < settings-DB < instance overlay
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Don't probe the real shell during tests.
vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 1, stdout: Buffer.from(''), error: null })),
  execSync: vi.fn(() => ''),
}))

// Settings DB mock — return a fixed key for OPENAI_API_KEY only.
vi.mock('../../src/main/db/database', () => ({
  getSetting: vi.fn((key: string) => {
    if (key === 'opencode.env.OPENAI_API_KEY') return 'settings-openai-key'
    if (key === 'opencode.env.NVIDIA_API_KEY') return 'settings-nvidia-key'
    if (key === 'opencode.env.ANTHROPIC_API_KEY') return 'settings-anthropic-key'
    return null
  }),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') },
}))

describe('buildOpencodeEnv overlay precedence', () => {
  beforeEach(async () => {
    const mod = await import('../../src/main/provider/adapters/opencode/env')
    mod._resetOpencodeEnvCachesForTests()
  })

  it('instance overlay wins over settings-DB', async () => {
    const { buildOpencodeEnv } = await import('../../src/main/provider/adapters/opencode/env')
    const env = buildOpencodeEnv({ OPENAI_API_KEY: 'instance-openai-key' })
    expect(env.OPENAI_API_KEY).toBe('instance-openai-key')
  })

  it('settings-DB key still applies when overlay does not set it', async () => {
    const { buildOpencodeEnv } = await import('../../src/main/provider/adapters/opencode/env')
    const env = buildOpencodeEnv({ NVIDIA_API_KEY: 'instance-nvidia-key' })
    expect(env.NVIDIA_API_KEY).toBe('instance-nvidia-key')
    expect(env.OPENAI_API_KEY).toBe('settings-openai-key')
  })

  it('overlay can introduce keys absent from settings/process env', async () => {
    const { buildOpencodeEnv } = await import('../../src/main/provider/adapters/opencode/env')
    const env = buildOpencodeEnv({ CUSTOM_INSTANCE_VAR: 'hello' })
    expect(env.CUSTOM_INSTANCE_VAR).toBe('hello')
  })

  it('instance overlay wins over settings-DB ANTHROPIC_API_KEY (Claude routed via OpenCode)', async () => {
    const { buildOpencodeEnv } = await import('../../src/main/provider/adapters/opencode/env')
    const env = buildOpencodeEnv({ ANTHROPIC_API_KEY: 'instance-anthropic-key' })
    expect(env.ANTHROPIC_API_KEY).toBe('instance-anthropic-key')
  })

  it('omitting overlay falls back to settings-DB values', async () => {
    const { buildOpencodeEnv } = await import('../../src/main/provider/adapters/opencode/env')
    const env = buildOpencodeEnv()
    expect(env.OPENAI_API_KEY).toBe('settings-openai-key')
    expect(env.NVIDIA_API_KEY).toBe('settings-nvidia-key')
  })
})
