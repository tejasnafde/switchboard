import { describe, expect, it } from 'vitest'
import {
  formatClaudeAuthStatus,
  oauthCreateDirCommand,
  oauthLoginCommand,
  suggestedOauthDir,
} from '../../src/shared/provider-auth-format'

describe('provider auth formatting', () => {
  it('formats Claude auth status JSON into a compact status string', () => {
    const status = formatClaudeAuthStatus(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'ai@geoiq.io',
      orgName: "ai@geoiq.io's Organization",
      subscriptionType: 'max',
    }))

    expect(status).toEqual({
      ok: true,
      message: "Account: ai@geoiq.io | Org: ai@geoiq.io's Organization | Plan: max | Auth: claude.ai / firstParty",
    })
  })

  it('returns the exact login command when Claude JSON says the dir is not logged in', () => {
    const status = formatClaudeAuthStatus('{"loggedIn":false}', '~/.claude-tejas')

    expect(status).toEqual({
      ok: false,
      message: 'Not logged in. Run: CLAUDE_CONFIG_DIR="$HOME/.claude-tejas" claude auth login',
    })
  })

  it('builds suggested OAuth dirs and copyable commands', () => {
    expect(suggestedOauthDir('claude-code', 'Tejas Work')).toBe('~/.claude-tejas-work')
    expect(suggestedOauthDir('codex', 'Tech Team')).toBe('~/.codex-tech-team')
    expect(oauthCreateDirCommand('~/.claude-tejas')).toBe('mkdir -p "$HOME/.claude-tejas"')
    expect(oauthLoginCommand('codex', '~/.codex-tech-team')).toBe('CODEX_HOME="$HOME/.codex-tech-team" codex login')
  })
})
