/**
 * claude-adapter's buildClaudeQueryEnv applies the per-instance env overlay
 * and CLAUDE_CONFIG_DIR override on top of the base SDK env.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildClaudeQueryEnv } from '../../src/main/provider/adapters/claude-adapter'

vi.mock('child_process', () => ({
  execSync: vi.fn(() => '/usr/local/bin/claude\n'),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/switchboard-vitest' },
}))

describe('buildClaudeQueryEnv', () => {
  it('overlays instance env on top of base, with overlay winning', () => {
    const base = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'shell-key' }
    const env = buildClaudeQueryEnv(base, { ANTHROPIC_API_KEY: 'instance-key' }, null)
    expect(env.ANTHROPIC_API_KEY).toBe('instance-key')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('does not clobber base values with empty overlay strings', () => {
    const base = { ANTHROPIC_API_KEY: 'shell-key' }
    const env = buildClaudeQueryEnv(base, { ANTHROPIC_API_KEY: '' }, null)
    expect(env.ANTHROPIC_API_KEY).toBe('shell-key')
  })

  it('sets CLAUDE_CONFIG_DIR when oauthDir is provided', () => {
    const env = buildClaudeQueryEnv({ PATH: '/usr/bin' }, {}, '/tmp/claude-work')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-work')
  })

  it('leaves CLAUDE_CONFIG_DIR untouched when oauthDir is null/empty', () => {
    const base = { CLAUDE_CONFIG_DIR: '/from/base' }
    expect(buildClaudeQueryEnv(base, {}, null).CLAUDE_CONFIG_DIR).toBe('/from/base')
    expect(buildClaudeQueryEnv(base, {}, '').CLAUDE_CONFIG_DIR).toBe('/from/base')
  })

  it('does not mutate the base env object', () => {
    const base = { ANTHROPIC_API_KEY: 'shell-key' }
    buildClaudeQueryEnv(base, { ANTHROPIC_API_KEY: 'instance-key' }, '/tmp/x')
    expect(base).toEqual({ ANTHROPIC_API_KEY: 'shell-key' })
  })
})
