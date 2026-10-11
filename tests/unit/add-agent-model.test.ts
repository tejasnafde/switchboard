import { describe, expect, it } from 'vitest'
import {
  ADD_AGENT_KINDS,
  addAgentInput,
  agentInitials,
  agentTileStatus,
  defaultSignInFolder,
  draftCredentials,
  envFromRows,
  installCommand,
  localCommandConfig,
  nameFromCommand,
  nameTaken,
  signInMethods,
  suggestedName,
  type AddAgentDraft,
} from '../../src/renderer/components/settings/add-agent-model'
import type { ProviderInstance } from '../../src/shared/types'

function account(agentType: ProviderInstance['agentType'], displayName: string): ProviderInstance {
  return { id: `${agentType}-${displayName}`, agentType, displayName } as ProviderInstance
}

function draft(over: Partial<AddAgentDraft>): AddAgentDraft {
  return {
    kind: 'claude-code',
    method: signInMethods('claude-code')[0],
    folder: '~/.claude-work',
    key: '',
    envRows: [],
    launch: null,
    ...over,
  }
}

describe('Add agent model', () => {
  it('lists the seven built-in agents, each with a way to sign in and to install', () => {
    expect(ADD_AGENT_KINDS).toEqual(['claude-code', 'codex', 'opencode', 'gemini', 'vibe', 'cline', 'copilot'])
    for (const kind of ADD_AGENT_KINDS) {
      expect(signInMethods(kind).length).toBeGreaterThan(0)
      expect(installCommand(kind)).toBeTruthy()
    }
    expect(signInMethods('acp-command').map((m) => m.id)).toEqual(['env'])
  })

  it('says why a tile cannot be picked, or how many accounts it has', () => {
    expect(agentTileStatus(undefined, 0)).toBe('Checking…')
    expect(agentTileStatus(false, 2)).toBe('Not installed')
    expect(agentTileStatus(true, 1)).toBe('1 account')
    expect(agentTileStatus(true, 3)).toBe('3 accounts')
    expect(agentTileStatus(true, 0)).toBe('Installed')
    expect(agentInitials('Claude Code')).toBe('CC')
    expect(agentInitials('Cline')).toBe('CL')
  })

  it('reads env rows, skipping empty ones and refusing bad names', () => {
    expect(
      envFromRows([
        { key: ' RUST_LOG ', value: 'warn' },
        { key: '', value: '' },
      ]),
    ).toEqual({
      env: { RUST_LOG: 'warn' },
    })
    expect(envFromRows([{ key: '1BAD', value: 'x' }])).toEqual({ error: '"1BAD" is not a variable name.' })
    expect(envFromRows([{ key: '', value: 'orphan' }])).toEqual({ error: '"(empty)" is not a variable name.' })
  })

  it('turns the local command form into a launch config', () => {
    expect(localCommandConfig({ command: ' kestrel-acp ', args: 'acp --log-level warn', cwd: '' })).toEqual({
      config: { command: 'kestrel-acp', args: ['acp', '--log-level', 'warn'], cwd: null },
    })
    expect(localCommandConfig({ command: ' ', args: '', cwd: '' })).toHaveProperty('error')
    expect(localCommandConfig({ command: 'a', args: '"open', cwd: '' })).toEqual({
      error: 'A quote in the arguments is not closed.',
    })
    expect(nameFromCommand('/usr/local/bin/kestrel-acp')).toBe('Kestrel Acp')
  })

  it('names the sign-in folder after the account, not the agent twice', () => {
    expect(defaultSignInFolder('claude-code', 'Claude Code Work')).toBe('~/.claude-work')
    expect(defaultSignInFolder('codex', 'Personal')).toBe('~/.codex-personal')
    expect(defaultSignInFolder('codex', '')).toBe('~/.codex-work')
  })

  it('suggests a free name and spots a taken one, per agent', () => {
    const instances = [account('codex', 'Codex Work'), account('claude-code', 'Work')]
    expect(suggestedName('codex', instances)).toBe('Codex Work 2')
    expect(suggestedName('claude-code', instances)).toBe('Claude Code Work')
    expect(nameTaken('codex', ' codex work ', instances)).toBe(true)
    expect(nameTaken('claude-code', 'Codex Work', instances)).toBe(false)
  })

  it('saves a tested agent with its sign-in folder and no launch config', () => {
    expect(addAgentInput(draft({}), { name: ' Claude Work ', accentColor: '#3da8ff' })).toEqual({
      agentType: 'claude-code',
      authMode: 'oauth_dir',
      oauthDir: '~/.claude-work',
      env: null,
      configJson: undefined,
      displayName: 'Claude Work',
      accentColor: '#3da8ff',
      enabled: true,
    })
  })

  it('stores an API key under its own variable', () => {
    const key = signInMethods('gemini').find((m) => m.id === 'key')!
    expect(draftCredentials(draft({ kind: 'gemini', method: key, key: 'k' }))).toMatchObject({
      authMode: 'env',
      env: { GEMINI_API_KEY: 'k' },
      oauthDir: null,
    })
  })

  it('starts an untested agent in plan mode and keeps a local command launch config', () => {
    const launch = { command: 'kestrel-acp', args: ['acp'], cwd: null }
    const input = addAgentInput(
      draft({
        kind: 'acp-command',
        method: signInMethods('acp-command')[0],
        envRows: [{ key: 'RUST_LOG', value: 'warn' }],
        launch,
      }),
      { name: 'Kestrel', accentColor: '#3dd17a' },
    )
    expect(input).toMatchObject({
      agentType: 'acp-command',
      authMode: 'env',
      env: { RUST_LOG: 'warn' },
      configJson: { launch, startMode: 'plan' },
    })
    const gemini = addAgentInput(draft({ kind: 'gemini', method: signInMethods('gemini')[0] }), {
      name: 'G',
      accentColor: '#fff',
    })
    expect(gemini.configJson).toEqual({ startMode: 'plan' })
  })
})
