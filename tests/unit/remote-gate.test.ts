import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  remoteBlockedProviderLabel,
  formatRemoteClaudeLoginPrompt,
  remoteClaudeLoginPrompt,
  checkRemoteClaudeAuth,
  sanitizeConfigSegment,
  remoteClaudeConfigDir,
  listRemoteClaudeConfigDirs,
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
    const msg = formatRemoteClaudeLoginPrompt('CLAUDE_CONFIG_DIR="/x" claude')
    expect(msg).toContain('not logged in to Claude')
    expect(msg).toContain('CLAUDE_CONFIG_DIR="/x" claude')
    expect(msg).toContain('send your message again')
  })

  it('guides through the interactive /login flow, not headless auth login', () => {
    const msg = formatRemoteClaudeLoginPrompt('CLAUDE_CONFIG_DIR="/x" claude')
    expect(msg).toContain('/login')
    expect(msg).not.toContain('claude auth login')
  })

  it('falls back to the bare CLI when given a blank string', () => {
    expect(formatRemoteClaudeLoginPrompt('')).toContain('claude')
    expect(formatRemoteClaudeLoginPrompt('')).not.toContain('claude auth login')
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
    expect(msg).toContain('claude')
    expect(msg).toContain('/login')
  })

  it('returns null when a non-empty .credentials.json exists in the dir', () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    writeFileSync(join(dir, '.credentials.json'), '{"t":1}')
    expect(remoteClaudeLoginPrompt(dir)).toBeNull()
  })

  it('prompts when .credentials.json exists but is empty (interrupted login)', () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    writeFileSync(join(dir, '.credentials.json'), '')
    expect(remoteClaudeLoginPrompt(dir)).not.toBeNull()
  })

  it('returns null when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    expect(remoteClaudeLoginPrompt(tmpDir())).toBeNull()
  })
})

describe('checkRemoteClaudeAuth', () => {
  const dirs: string[] = []
  const savedKey = process.env.ANTHROPIC_API_KEY

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedKey
  })

  function tmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'sb-remote-check-'))
    dirs.push(d)
    return d
  }

  it('reports not logged in with the interactive login command when the dir has no credentials', () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    const res = checkRemoteClaudeAuth(dir)
    expect(res.loggedIn).toBe(false)
    expect(res.configDir).toBe(dir)
    expect(res.loginCommand).toContain('CLAUDE_CONFIG_DIR=')
    expect(res.loginCommand).toContain('claude')
    expect(res.loginCommand).not.toContain('claude auth login')
  })

  it('reports logged in when a non-empty .credentials.json exists', () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    writeFileSync(join(dir, '.credentials.json'), '{"t":1}')
    const res = checkRemoteClaudeAuth(dir)
    expect(res.loggedIn).toBe(true)
    expect(res.configDir).toBe(dir)
  })

  it('reports not logged in when .credentials.json is empty (interrupted login)', () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    writeFileSync(join(dir, '.credentials.json'), '')
    expect(checkRemoteClaudeAuth(dir).loggedIn).toBe(false)
  })

  it('reports logged in when ANTHROPIC_API_KEY overrides missing credentials', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    expect(checkRemoteClaudeAuth(tmpDir()).loggedIn).toBe(true)
  })

  it('agrees with remoteClaudeLoginPrompt on both verdicts', () => {
    delete process.env.ANTHROPIC_API_KEY
    const bare = tmpDir()
    expect(checkRemoteClaudeAuth(bare).loggedIn).toBe(false)
    expect(remoteClaudeLoginPrompt(bare)).not.toBeNull()
    const authed = tmpDir()
    writeFileSync(join(authed, '.credentials.json'), '{"t":1}')
    expect(checkRemoteClaudeAuth(authed).loggedIn).toBe(true)
    expect(remoteClaudeLoginPrompt(authed)).toBeNull()
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

describe('listRemoteClaudeConfigDirs', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function tmpHome(): string {
    const d = mkdtempSync(join(tmpdir(), 'sb-remote-home-'))
    dirs.push(d)
    return d
  }

  it('lists every .claude* directory under the home, skipping files and unrelated dirs', () => {
    const home = tmpHome()
    mkdirSync(join(home, '.claude'))
    mkdirSync(join(home, '.claude-tech-team'))
    mkdirSync(join(home, '.config'))
    writeFileSync(join(home, '.claude.json'), '{}')
    const found = listRemoteClaudeConfigDirs(home)
    expect(found.sort()).toEqual([join(home, '.claude'), join(home, '.claude-tech-team')])
  })

  it('includes a free-text config dir (non-.claude oauth_dir name) via its projects/ marker', () => {
    const home = tmpHome()
    mkdirSync(join(home, 'work-profile', 'projects'), { recursive: true })
    mkdirSync(join(home, 'some-repo'))
    const found = listRemoteClaudeConfigDirs(home)
    expect(found).toEqual([join(home, 'work-profile')])
  })

  it('returns empty for a missing or empty home', () => {
    expect(listRemoteClaudeConfigDirs('/nonexistent-sb-home')).toEqual([])
    expect(listRemoteClaudeConfigDirs(tmpHome())).toEqual([])
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
