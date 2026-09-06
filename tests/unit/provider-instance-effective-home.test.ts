/**
 * Behavior 2: Settings must show the credential home an instance REALLY
 * runs under.
 *
 * `effectiveOauthDir` on the wire is what the UI labels "the directory in
 * use". It was derived from the `oauth_dir` column alone, so a legacy
 * env-mode profile - whose home lives in a `CODEX_HOME`/`CLAUDE_CONFIG_DIR`
 * inside its encrypted env overlay - was reported as the canonical default
 * while every session, Test and Usage probe ran somewhere else entirely. The
 * user reads "~/.codex" and gets billed on another account.
 *
 * The policy this pins: a structural credential var in an overlay is an
 * explicit profile-home input, not hidden general env. Legacy rows keep
 * working (moving them would silently switch accounts), but they become
 * visible and validated like an oauth_dir. Two layers cooperate:
 *
 *   - the DB layer decides what it can WITHOUT decrypting, because LIST runs
 *     at every boot and decrypting there hits the OS keychain. It uses the
 *     plaintext `env_keys` column, and marks a row `unresolved` when only the
 *     ciphertext could answer.
 *   - the main IPC layer - the authoritative one, which may decrypt - fills
 *     those in from the real resolved env before the renderer sees them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

const decryptCalls = { n: 0 }

vi.mock('../../src/main/runtime', () => ({
  isElectron: false,
  userDataDir: () => '/tmp/switchboard-vitest',
  appRootDir: () => '/tmp/switchboard-vitest',
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.concat([Buffer.from([0xAA, 0xBB]), Buffer.from(s, 'utf-8')]),
    decryptString: (buf: Buffer) => {
      decryptCalls.n += 1
      return buf.subarray(2).toString('utf-8')
    },
  }),
}))

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}))

interface Row {
  id: string
  agent_type: string
  display_name: string
  accent_color: string | null
  auth_mode: string
  env_encrypted: Buffer | null
  env_keys: string | null
  oauth_dir: string | null
  config_json: string | null
  enabled: number
  created_at: number
  updated_at: number
}

const store = new Map<string, Row>()

function seedRow(over: Partial<Row> & { id: string; agent_type: string }): Row {
  const t = 1000
  const row: Row = {
    display_name: over.id,
    accent_color: null,
    auth_mode: 'env',
    env_encrypted: null,
    env_keys: null,
    oauth_dir: null,
    config_json: null,
    enabled: 1,
    created_at: t,
    updated_at: t,
    ...over,
  }
  store.set(row.id, row)
  return row
}

/** Encrypted exactly as the app writes it: magic prefix + ciphertext. */
function encrypted(env: Record<string, string>): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x53, 0x42, 0x45]),
    Buffer.from([0xAA, 0xBB]),
    Buffer.from(JSON.stringify(env), 'utf-8'),
  ])
}

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      const norm = sql.replace(/\s+/g, ' ').trim()
      return {
        get: (...args: unknown[]) => {
          if (norm.startsWith('SELECT * FROM provider_instances WHERE id = ?')) return store.get(args[0] as string)
          throw new Error(`mock get: unhandled SQL: ${norm}`)
        },
        all: () => [...store.values()].sort((a, b) =>
          a.agent_type.localeCompare(b.agent_type) || a.created_at - b.created_at),
        run: () => ({ changes: 0 }),
      }
    },
  }),
}))

const CANONICAL_CODEX = join(homedir(), '.codex')
const CANONICAL_CLAUDE = join(homedir(), '.claude')

beforeEach(() => {
  store.clear()
  decryptCalls.n = 0
})

describe('wire effectiveOauthDir - what the DB layer can say without decrypting', () => {
  it('reports the canonical default for a plain default row of either kind', async () => {
    seedRow({ id: 'codex-default', agent_type: 'codex' })
    seedRow({ id: 'claude-code-default', agent_type: 'claude-code' })
    const { listProviderInstances } = await import('../../src/main/db/providerInstances')
    const byId = new Map(listProviderInstances().map((r) => [r.id, r]))

    expect(byId.get('codex-default')).toMatchObject({
      effectiveOauthDir: CANONICAL_CODEX, effectiveOauthDirSource: 'default',
    })
    // Claude had no default at this layer at all (it reported null) even
    // though a Claude session with no oauth_dir now pins ~/.claude.
    expect(byId.get('claude-code-default')).toMatchObject({
      effectiveOauthDir: CANONICAL_CLAUDE, effectiveOauthDirSource: 'default',
    })
  })

  it('canonicalizes an oauth_dir row but keeps the literal the user typed', async () => {
    seedRow({ id: 'codex-work', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: '~/.codex-work/' })
    const { listProviderInstances } = await import('../../src/main/db/providerInstances')
    const [row] = listProviderInstances()

    expect(row.oauthDir).toBe('~/.codex-work/')
    expect(row.effectiveOauthDir).toBe(join(homedir(), '.codex-work'))
    expect(row.effectiveOauthDirSource).toBe('oauth_dir')
  })

  it('marks an overlay-homed row unresolved instead of claiming the default', async () => {
    seedRow({
      id: 'codex-legacy', agent_type: 'codex',
      env_encrypted: encrypted({ CODEX_HOME: '/tmp/legacy-codex' }),
      env_keys: JSON.stringify(['CODEX_HOME']),
    })
    const { listProviderInstances } = await import('../../src/main/db/providerInstances')
    const [row] = listProviderInstances()

    expect(row.effectiveOauthDirSource).toBe('unresolved')
    expect(row.effectiveOauthDir).not.toBe(CANONICAL_CODEX)
    expect(decryptCalls.n).toBe(0) // LIST must not touch the keychain
  })

  it('marks a legacy row with an unreadable env_keys column unresolved too', async () => {
    seedRow({
      id: 'codex-ancient', agent_type: 'codex',
      env_encrypted: encrypted({ OPENAI_API_KEY: 'sk-x' }),
      env_keys: null, // predates the env_keys column - could be anything
    })
    const { listProviderInstances } = await import('../../src/main/db/providerInstances')
    expect(listProviderInstances()[0].effectiveOauthDirSource).toBe('unresolved')
    expect(decryptCalls.n).toBe(0)
  })

  it('does not brand a BLANK overlay home as isolated - it lands on the shared default', async () => {
    // A readable (plaintext-fallback) blob whose key list names the home var
    // but whose VALUE is empty resolves to the canonical default at spawn
    // (effectiveCredentialHome falls back) and applyEnvOverlay skips it
    // entirely. Reporting 'env' here made Settings render the shared home as
    // an isolated legacy profile - the one row that most needs the isolation
    // warning is the row that would not get one.
    seedRow({
      id: 'codex-blank', agent_type: 'codex',
      env_encrypted: Buffer.from(JSON.stringify({ CODEX_HOME: '  ' }), 'utf-8'),
      env_keys: JSON.stringify(['CODEX_HOME']),
    })
    const { listProviderInstances } = await import('../../src/main/db/providerInstances')
    expect(listProviderInstances()[0]).toMatchObject({
      effectiveOauthDir: CANONICAL_CODEX, effectiveOauthDirSource: 'default',
    })
  })

  it('keeps a row whose keys are known and home-free on the default', async () => {
    seedRow({
      id: 'codex-keyed', agent_type: 'codex',
      env_encrypted: encrypted({ OPENAI_API_KEY: 'sk-x' }),
      env_keys: JSON.stringify(['OPENAI_API_KEY']),
    })
    const { listProviderInstances } = await import('../../src/main/db/providerInstances')
    expect(listProviderInstances()[0]).toMatchObject({
      effectiveOauthDir: CANONICAL_CODEX, effectiveOauthDirSource: 'default',
    })
    expect(decryptCalls.n).toBe(0)
  })
})

describe('resolveEffectiveOauthDir - the decrypting resolver behind the IPC layer', () => {
  it('reports the overlay home a legacy env-mode row really runs under', async () => {
    seedRow({
      id: 'codex-legacy', agent_type: 'codex',
      env_encrypted: encrypted({ CODEX_HOME: '~/.codex-legacy/' }),
      env_keys: JSON.stringify(['CODEX_HOME']),
    })
    const { resolveEffectiveOauthDir } = await import('../../src/main/db/providerInstances')

    expect(resolveEffectiveOauthDir('codex-legacy')).toEqual({
      effectiveOauthDir: join(homedir(), '.codex-legacy'),
      effectiveOauthDirSource: 'env',
    })
  })

  it('reports the default when the decrypted overlay turns out to hold no home', async () => {
    seedRow({
      id: 'codex-ancient', agent_type: 'codex',
      env_encrypted: encrypted({ OPENAI_API_KEY: 'sk-x' }),
      env_keys: null,
    })
    const { resolveEffectiveOauthDir } = await import('../../src/main/db/providerInstances')
    expect(resolveEffectiveOauthDir('codex-ancient')).toEqual({
      effectiveOauthDir: CANONICAL_CODEX,
      effectiveOauthDirSource: 'default',
    })
  })

  // canonicalizeOauthPath runs every home through node:path's normalize(),
  // which is platform-native by design; this fixture asserts an exact
  // POSIX-literal string round-trip, which only holds on a POSIX host - skip
  // on win32 rather than assert a separator style no real Windows install
  // would produce either (see oauth-path.ts).
  it.skipIf(process.platform === 'win32')('lets oauth_dir win over an overlay home, exactly as a spawn would', async () => {
    seedRow({
      id: 'codex-both', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: '/tmp/explicit',
      env_encrypted: encrypted({ CODEX_HOME: '/tmp/overlay' }),
      env_keys: JSON.stringify(['CODEX_HOME']),
    })
    const { resolveEffectiveOauthDir } = await import('../../src/main/db/providerInstances')
    expect(resolveEffectiveOauthDir('codex-both')).toEqual({
      effectiveOauthDir: '/tmp/explicit',
      effectiveOauthDirSource: 'oauth_dir',
    })
  })

  it('returns null for an unknown id rather than inventing a directory', async () => {
    const { resolveEffectiveOauthDir } = await import('../../src/main/db/providerInstances')
    expect(resolveEffectiveOauthDir('nope')).toBeNull()
  })
})
