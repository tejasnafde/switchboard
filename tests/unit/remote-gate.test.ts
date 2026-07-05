import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  remoteBlockedProviderLabel,
  formatRemoteClaudeLoginPrompt,
  remoteClaudeLoginPrompt,
  sanitizeConfigSegment,
  remoteClaudeConfigDir,
} from '../../src/main/provider/remote-gate'

describe('remoteBlockedProviderLabel', () => {
  it('allows claude on remote (null label)', () => {
    expect(remoteBlockedProviderLabel('claude')).toBeNull()
  })

  it('blocks codex and opencode with readable labels', () => {
    expect(remoteBlockedProviderLabel('codex')).toBe('Codex')
    expect(remoteBlockedProviderLabel('opencode')).toBe('OpenCode')
  })
})

describe('formatRemoteClaudeLoginPrompt', () => {
  it('embeds the given command and the not-logged-in copy', () => {
    const msg = formatRemoteClaudeLoginPrompt('CLAUDE_CONFIG_DIR="/x" claude auth login')
    expect(msg).toContain('not logged in to Claude')
    expect(msg).toContain('CLAUDE_CONFIG_DIR="/x" claude auth login')
    expect(msg).toContain('Then send your message again.')
  })

  it('falls back to a bare login command when given a blank string', () => {
    expect(formatRemoteClaudeLoginPrompt('')).toContain('claude auth login')
  })
})

describe('remoteClaudeLoginPrompt', () => {
  const dirs: string[] = []
  const savedKey = process.env.ANTHROPIC_API_KEY

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedKey
  })

  function tmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'sb-remote-gate-'))
    dirs.push(d)
    return d
  }

  it('returns a prompt when the config dir has no credentials', () => {
    delete process.env.ANTHROPIC_API_KEY
    const msg = remoteClaudeLoginPrompt(tmpDir())
    expect(msg).not.toBeNull()
    expect(msg).toContain('not logged in to Claude')
    expect(msg).toContain('claude auth login')
  })

  it('returns null when a .credentials.json exists in the dir', () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    writeFileSync(join(dir, '.credentials.json'), '{"t":1}')
    expect(remoteClaudeLoginPrompt(dir)).toBeNull()
  })

  it('returns null when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    expect(remoteClaudeLoginPrompt(tmpDir())).toBeNull()
  })
})

describe('sanitizeConfigSegment', () => {
  it('passes a normal dotted dir name unchanged', () => {
    expect(sanitizeConfigSegment('.claude-akshaya')).toBe('.claude-akshaya')
    expect(sanitizeConfigSegment('.claude_tech-team.2')).toBe('.claude_tech-team.2')
  })

  it('strips path separators, collapsing a nested path to a single segment', () => {
    // Separators are removed, not split - the remaining chars concatenate.
    expect(sanitizeConfigSegment('a/b')).toBe('ab')
  })

  it('neutralizes traversal payloads', () => {
    // '../evil' loses the slash -> '..evil' (still a single safe segment, no escape).
    expect(sanitizeConfigSegment('../evil')).toBe('..evil')
    expect(sanitizeConfigSegment('../../etc/passwd')).toBe('....etcpasswd')
  })

  it('falls back to .claude for empty / dot / dotdot inputs', () => {
    expect(sanitizeConfigSegment('')).toBe('.claude')
    expect(sanitizeConfigSegment(undefined)).toBe('.claude')
    expect(sanitizeConfigSegment('.')).toBe('.claude')
    expect(sanitizeConfigSegment('..')).toBe('.claude')
    expect(sanitizeConfigSegment('/')).toBe('.claude')
  })
})

describe('remoteClaudeConfigDir', () => {
  it('joins the sanitized name under the home dir', () => {
    expect(remoteClaudeConfigDir('.claude-akshaya')).toBe(join(homedir(), '.claude-akshaya'))
  })

  it('falls back to ~/.claude when the name is falsy', () => {
    expect(remoteClaudeConfigDir(undefined)).toBe(join(homedir(), '.claude'))
    expect(remoteClaudeConfigDir('')).toBe(join(homedir(), '.claude'))
  })

  it('never escapes the home dir for a traversal payload', () => {
    const resolved = remoteClaudeConfigDir('../../etc')
    expect(resolved.startsWith(homedir())).toBe(true)
    expect(resolved).toBe(join(homedir(), '....etc'))
  })
})
