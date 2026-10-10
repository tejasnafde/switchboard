/**
 * One launch config per ACP agent. Each generic agent's command matches its
 * documented ACP entry point; OpenCode's config reproduces exactly what the
 * dedicated adapter did before it moved onto the generic one.
 */
import { describe, expect, it, vi } from 'vitest'

const lookups = vi.hoisted(() => [] as string[])

vi.mock('../../src/main/provider/adapters/acp/agent-env', () => ({
  findAgentBinary: (name: string) => {
    lookups.push(name)
    return name === 'missing' ? null : `/usr/local/bin/${name}`
  },
  buildAgentEnv: (overlay: Record<string, string>) => ({ BASE: '1', ...overlay }),
}))

vi.mock('../../src/main/provider/adapters/opencode/env', () => ({
  findOpencodePath: () => '/opt/homebrew/bin/opencode',
  buildOpencodeEnv: (overlay: Record<string, string>) => ({ ...overlay }),
}))

import { genericAcpLaunchConfig } from '../../src/main/provider/adapters/acp/agents'
import { OPENCODE_ACP_LAUNCH } from '../../src/main/provider/adapters/opencode-acp-adapter'
import { GENERIC_ACP_AGENTS } from '../../src/shared/acp-agents'

const EXPECTED = {
  gemini: { binary: 'gemini', args: ['--acp'], label: 'Gemini CLI', install: 'npm install -g @google/gemini-cli' },
  vibe: { binary: 'vibe-acp', args: [], label: 'Mistral Vibe', install: 'uv tool install mistral-vibe' },
  cline: { binary: 'cline', args: ['--acp'], label: 'Cline', install: 'npm install -g cline' },
  copilot: { binary: 'copilot', args: ['--acp'], label: 'GitHub Copilot', install: 'npm install -g @github/copilot' },
} as const

describe('generic ACP launch configs', () => {
  it('has a config for every generic agent', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...GENERIC_ACP_AGENTS].sort())
  })

  for (const agent of GENERIC_ACP_AGENTS) {
    it(`${agent}: starts its documented ACP command`, () => {
      const config = genericAcpLaunchConfig(agent)
      const expected = EXPECTED[agent]
      expect(config.provider).toBe(agent)
      expect(config.label).toBe(expected.label)
      expect(config.findBinary()).toBe(`/usr/local/bin/${expected.binary}`)
      expect(lookups.at(-1)).toBe(expected.binary)
      expect(config.args('/tmp/project')).toEqual(expected.args)
      expect(config.notFoundMessage).toContain(expected.install)
      expect(config.signInHint.length).toBeGreaterThan(0)
      expect(config.modes).toEqual({ kind: 'advertised' })
      // No config reading of its own and no auto-allow of our MCP tools.
      expect(config.prepareSession).toBeUndefined()
      expect(config.buildEnv({ GEMINI_API_KEY: 'k' })).toEqual({ BASE: '1', GEMINI_API_KEY: 'k' })
      expect(config.modelLabel({ modelId: 'a/b', name: 'Nice name' })).toBe('Nice name')
      expect(config.modelLabel({ modelId: 'a/b', name: '' })).toBe('a/b')
    })
  }
})

describe('OpenCode launch config', () => {
  it('keeps the command, modes and question tool flag OpenCode always had', () => {
    expect(OPENCODE_ACP_LAUNCH.provider).toBe('opencode')
    expect(OPENCODE_ACP_LAUNCH.findBinary()).toBe('/opt/homebrew/bin/opencode')
    expect(OPENCODE_ACP_LAUNCH.args('/tmp/p')).toEqual(['acp', '--cwd', '/tmp/p'])
    expect(OPENCODE_ACP_LAUNCH.modes).toEqual({ kind: 'fixed', plan: 'plan', other: 'build' })
    expect(OPENCODE_ACP_LAUNCH.buildEnv({ NVIDIA_API_KEY: 'k' })).toEqual({ OPENCODE_ENABLE_QUESTION_TOOL: '1', NVIDIA_API_KEY: 'k' })
    expect(OPENCODE_ACP_LAUNCH.preflight).toBeTypeOf('function')
    expect(OPENCODE_ACP_LAUNCH.prepareSession).toBeTypeOf('function')
  })

  it('reads model variants from set_model _meta', () => {
    expect(OPENCODE_ACP_LAUNCH.modelVariants?.({ opencode: { modelId: 'm', variant: 'high', availableVariants: ['low', 'high'] } }))
      .toEqual({ modelId: 'm', variant: 'high', availableVariants: ['low', 'high'] })
    expect(OPENCODE_ACP_LAUNCH.modelVariants?.(undefined)).toBeNull()
  })
})
