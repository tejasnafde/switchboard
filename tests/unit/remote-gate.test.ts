import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Stands in for the `codex login status` probe behavior 7 wires in.
//
// Adjusted from a fixed always-logged-in stub: with the probe live, a single
// constant verdict makes the two Codex cases in this file contradict each
// other - "no credential anywhere" and "logged in via the OS keyring" are the
// same tmpdir with no auth.json, and can only differ by what `codex login
// status` reports. So the verdict is per-test state, defaulting to the
// not-logged-in exit the CLI really gives for an empty CODEX_HOME.
const codexStatus = vi.hoisted(() => ({
  result: { status: 1, stdout: '', stderr: 'Not logged in', error: undefined } as {
    status: number
    stdout: string
    stderr: string
    error: Error | undefined
  },
}))

const LOGGED_IN_STDOUT = JSON.stringify({ loggedIn: true, account: { email: 'user@example.com' } })

vi.mock('node:child_process', () => ({
  // The probe is async now (behavior 4) - a synchronous one would freeze the
  // remote's event loop. The sync entry points stay mocked as throwers so a
  // regression to spawnSync fails loudly here.
  execFileSync: vi.fn(() => { throw new Error('login probe must not block the event loop') }),
  spawnSync: vi.fn(() => { throw new Error('login probe must not block the event loop') }),
  execFile: vi.fn((
    _bin: string,
    _args: string[],
    _opts: unknown,
    cb: (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => void,
  ) => {
    const { status, stdout, stderr } = codexStatus.result
    queueMicrotask(() => {
      if (status === 0) cb(null, stdout, stderr)
      else {
        const err = new Error(`exit ${status}`) as Error & { code?: number }
        err.code = status
        cb(err, stdout, stderr)
      }
    })
    return { kill: () => {} }
  }),
}))
import {
  remoteBlockedProviderLabel,
  formatRemoteClaudeLoginPrompt,
  remoteClaudeLoginPrompt,
  checkRemoteClaudeAuth,
  sanitizeConfigSegment,
  remoteClaudeConfigDir,
  listRemoteClaudeConfigDirs,
  checkRemoteProviderAuth,
  remoteProviderConfigDir,
  remoteProviderLoginPrompt,
  __resetRemoteCodexLoginProbeCacheForTests,
} from '../../src/main/provider/remote-gate'

describe('remoteBlockedProviderLabel', () => {
  it('allows claude on remote (null label)', () => {
    expect(remoteBlockedProviderLabel('claude')).toBeNull()
  })

  it('allows codex but keeps opencode maintenance-only on remote', () => {
    expect(remoteBlockedProviderLabel('codex')).toBeNull()
    expect(remoteBlockedProviderLabel('opencode')).toBe('OpenCode')
  })
})

describe('remote Codex auth', () => {
  const dirs: string[] = []
  const savedKey = process.env.OPENAI_API_KEY

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
  })

  function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sb-remote-codex-'))
    dirs.push(dir)
    return dir
  }

  it('uses a durable CODEX_HOME under the runtime user home', () => {
    expect(remoteProviderConfigDir('codex', '.codex-work')).toBe(join(homedir(), '.codex-work'))
    expect(remoteProviderConfigDir('codex', undefined)).toBe(join(homedir(), '.codex'))
  })

  it('recognizes Codex auth.json and otherwise recommends device auth', async () => {
    delete process.env.OPENAI_API_KEY
    const dir = tmpDir()
    const missing = await checkRemoteProviderAuth('codex', dir)
    expect(missing).toMatchObject({ loggedIn: false, configDir: dir })
    // Double-quoted on a shell-safe path (POSIX tmpdirs); shellQuoteDir falls
    // back to single-quoting on win32's os.tmpdir(), whose backslashes aren't
    // shell-safe to leave inside double quotes - both are the quoter's
    // documented, correct behavior for the character set it was given.
    expect(missing.loginCommand).toMatch(/^CODEX_HOME=(".+"|'.+') codex login --device-auth$/)
    expect(await remoteProviderLoginPrompt('codex', dir)).toContain('codex login --device-auth')

    writeFileSync(join(dir, 'auth.json'), '{"tokens":{}}')
    // No cache reset: auth.json is checked before the probe, so it must flip
    // the verdict even while a not-logged-in probe result is still cached.
    expect((await checkRemoteProviderAuth('codex', dir)).loggedIn).toBe(true)
    expect(await remoteProviderLoginPrompt('codex', dir)).toBeNull()
  })
})

describe('remote Codex auth - keyring-backed login (behavior 7)', () => {
  const dirs: string[] = []
  const savedKey = process.env.OPENAI_API_KEY

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
    codexStatus.result = { status: 1, stdout: '', stderr: 'Not logged in', error: undefined }
    __resetRemoteCodexLoginProbeCacheForTests()
  })

  function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sb-remote-codex-keyring-'))
    dirs.push(dir)
    return dir
  }

  it('recognizes a keyring-backed login instead of relying only on auth.json', async () => {
    delete process.env.OPENAI_API_KEY
    codexStatus.result = { status: 0, stdout: LOGGED_IN_STDOUT, stderr: '', error: undefined }
    const dir = tmpDir()
    // No auth.json written - this login lives only in the OS keyring. A
    // bounded `codex login status` run under CODEX_HOME=dir (see the
    // child_process mock above) would report logged in; today's check has
    // no such probe and can only see auth.json / OPENAI_API_KEY.
    const result = await checkRemoteProviderAuth('codex', dir)
    expect(result.loggedIn).toBe(true)
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

  it('returns a prompt when the config dir has no credentials', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const msg = await remoteClaudeLoginPrompt(tmpDir())
    expect(msg).not.toBeNull()
    expect(msg).toContain('not logged in to Claude')
    expect(msg).toContain('claude')
    expect(msg).toContain('/login')
  })

  it('returns null when a non-empty .credentials.json exists in the dir', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    writeFileSync(join(dir, '.credentials.json'), '{"t":1}')
    expect(await remoteClaudeLoginPrompt(dir)).toBeNull()
  })

  it('prompts when .credentials.json exists but is empty (interrupted login)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    writeFileSync(join(dir, '.credentials.json'), '')
    expect(await remoteClaudeLoginPrompt(dir)).not.toBeNull()
  })

  it('returns null when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    expect(await remoteClaudeLoginPrompt(tmpDir())).toBeNull()
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

  it('reports not logged in with the interactive login command when the dir has no credentials', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    const res = await checkRemoteClaudeAuth(dir)
    expect(res.loggedIn).toBe(false)
    expect(res.configDir).toBe(dir)
    expect(res.loginCommand).toContain('CLAUDE_CONFIG_DIR=')
    expect(res.loginCommand).toContain('claude')
    expect(res.loginCommand).not.toContain('claude auth login')
  })

  it('reports logged in when a non-empty .credentials.json exists', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    writeFileSync(join(dir, '.credentials.json'), '{"t":1}')
    const res = await checkRemoteClaudeAuth(dir)
    expect(res.loggedIn).toBe(true)
    expect(res.configDir).toBe(dir)
  })

  it('reports not logged in when .credentials.json is empty (interrupted login)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const dir = tmpDir()
    writeFileSync(join(dir, '.credentials.json'), '')
    expect((await checkRemoteClaudeAuth(dir)).loggedIn).toBe(false)
  })

  it('reports logged in when ANTHROPIC_API_KEY overrides missing credentials', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    expect((await checkRemoteClaudeAuth(tmpDir())).loggedIn).toBe(true)
  })

  it('agrees with remoteClaudeLoginPrompt on both verdicts', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const bare = tmpDir()
    expect((await checkRemoteClaudeAuth(bare)).loggedIn).toBe(false)
    expect(await remoteClaudeLoginPrompt(bare)).not.toBeNull()
    const authed = tmpDir()
    writeFileSync(join(authed, '.credentials.json'), '{"t":1}')
    expect((await checkRemoteClaudeAuth(authed)).loggedIn).toBe(true)
    expect(await remoteClaudeLoginPrompt(authed)).toBeNull()
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
