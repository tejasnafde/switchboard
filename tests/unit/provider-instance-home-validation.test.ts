/**
 * Behaviors 7 and 8: what `upsertProviderInstance` must guard about an
 * instance's CREDENTIAL HOME, not just about its `oauth_dir` column.
 *
 * The home is whatever `resolveInstanceEnv` really resolves - the row's
 * `oauth_dir` if it has one, else a `CODEX_HOME`/`CLAUDE_CONFIG_DIR` in its
 * own env overlay (legacy env-mode profiles predate the oauth_dir field, and
 * are still honored so nobody's account silently moves). Validation that only
 * looked at the column therefore had two holes:
 *
 *   7. Uniqueness was blind to overlays. "Work" (oauth_dir=/x) and "Personal"
 *      (env CODEX_HOME=/x) are not two profiles, they are one account wearing
 *      two names - and the UI shows the user picking between them.
 *   8. The `~/.codex` reserved-path rule fired on rows that were ALREADY
 *      sitting there. A legacy non-default row pointed at the canonical home
 *      could not be renamed, recolored or disabled: every save re-threw, with
 *      no way out of the dialog. The rule exists to stop a row from HIJACKING
 *      the default's dir, so it belongs on saves that move a row there, not
 *      on ones that leave it where it already was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

vi.mock('../../src/main/runtime', () => ({
  isElectron: false,
  userDataDir: () => '/tmp/switchboard-vitest',
  appRootDir: () => '/tmp/switchboard-vitest',
  getSafeStorage: () => null, // plaintext-JSON blobs: readable, still magic-less
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
  const t = Date.now()
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

/** A legacy env-mode profile: its credential home lives in the env overlay. */
function envRow(id: string, agentType: string, env: Record<string, string>, over: Partial<Row> = {}): Row {
  return seedRow({
    id,
    agent_type: agentType,
    auth_mode: 'env',
    env_encrypted: Buffer.from(JSON.stringify(env), 'utf-8'),
    env_keys: JSON.stringify(Object.keys(env).sort()),
    ...over,
  })
}

function prepare(sql: string) {
  const norm = sql.replace(/\s+/g, ' ').trim()
  return {
    get: (...args: unknown[]) => {
      if (norm.startsWith('SELECT * FROM provider_instances WHERE id = ?')) return store.get(args[0] as string)
      throw new Error(`mock get: unhandled SQL: ${norm}`)
    },
    all: () => {
      if (norm.startsWith('SELECT * FROM provider_instances ORDER BY')) {
        return [...store.values()].sort((a, b) =>
          a.agent_type.localeCompare(b.agent_type) || a.created_at - b.created_at)
      }
      throw new Error(`mock all: unhandled SQL: ${norm}`)
    },
    run: (...args: unknown[]) => {
      if (norm.startsWith('INSERT INTO provider_instances')) {
        const [id, agent_type, display_name, accent_color, auth_mode,
          env_encrypted, env_keys, oauth_dir, config_json, enabled, created_at, updated_at] =
          args as [string, string, string, string | null, string, Buffer | null, string | null, string | null, string | null, number, number, number]
        store.set(id, { id, agent_type, display_name, accent_color, auth_mode, env_encrypted, env_keys, oauth_dir, config_json, enabled, created_at, updated_at })
        return { changes: 1 }
      }
      if (norm.startsWith('UPDATE provider_instances SET display_name')) {
        const [name, accent, auth, env, envKeys, oauthDir, config, enabled, updated, id] =
          args as [string, string | null, string, Buffer | null, string | null, string | null, string | null, number, number, string]
        const r = store.get(id)
        if (!r) return { changes: 0 }
        Object.assign(r, {
          display_name: name, accent_color: accent, auth_mode: auth, env_encrypted: env,
          env_keys: envKeys, oauth_dir: oauthDir, config_json: config, enabled, updated_at: updated,
        })
        return { changes: 1 }
      }
      throw new Error(`mock run: unhandled SQL: ${norm}`)
    },
  }
}

vi.mock('../../src/main/db/database', () => ({ getDb: () => ({ prepare }) }))

const CANONICAL_CODEX = join(homedir(), '.codex')
const CANONICAL_CLAUDE = join(homedir(), '.claude')

async function db() {
  return import('../../src/main/db/providerInstances')
}

beforeEach(() => {
  store.clear()
  seedRow({ id: 'codex-default', agent_type: 'codex' })
  seedRow({ id: 'claude-code-default', agent_type: 'claude-code' })
})

describe('credential-home uniqueness across auth modes (behavior 7)', () => {
  it('rejects an oauth_dir that an env-mode row already reaches through its overlay', async () => {
    const { upsertProviderInstance } = await db()
    envRow('codex-legacy', 'codex', { CODEX_HOME: '/tmp/shared-codex' })

    expect(() => upsertProviderInstance({
      agentType: 'codex', displayName: 'Work', authMode: 'oauth_dir', oauthDir: '/tmp/shared-codex',
    })).toThrow(/already used by instance codex-legacy/)
  })

  it('rejects an env overlay home that an oauth_dir row already owns', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({ id: 'codex-work', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: '/tmp/shared-codex' })

    expect(() => upsertProviderInstance({
      agentType: 'codex', displayName: 'Legacy', authMode: 'env', env: { CODEX_HOME: '/tmp/shared-codex' },
    })).toThrow(/already used by instance codex-work/)
  })

  it('compares homes canonically, not as typed', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({ id: 'codex-work', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: '/tmp/shared-codex' })

    expect(() => upsertProviderInstance({
      agentType: 'codex', displayName: 'Sneaky', authMode: 'env',
      env: { CODEX_HOME: '/tmp/other/../shared-codex/' },
    })).toThrow(/already used by instance codex-work/)
  })

  it('applies the same rule to claude CLAUDE_CONFIG_DIR overlays', async () => {
    const { upsertProviderInstance } = await db()
    envRow('claude-legacy', 'claude-code', { CLAUDE_CONFIG_DIR: '/tmp/shared-claude' })

    expect(() => upsertProviderInstance({
      agentType: 'claude-code', displayName: 'Work', authMode: 'oauth_dir', oauthDir: '/tmp/shared-claude',
    })).toThrow(/already used by instance claude-legacy/)
  })

  it('ignores a cross-kind var in an overlay - it is ordinary env, not a home', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({ id: 'codex-work', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: '/tmp/shared-codex' })

    expect(() => upsertProviderInstance({
      agentType: 'claude-code', displayName: 'Unrelated', authMode: 'env',
      env: { CODEX_HOME: '/tmp/shared-codex' },
    })).not.toThrow()
  })

  it('still ignores disabled rows - a disabled profile runs nothing', async () => {
    const { upsertProviderInstance } = await db()
    envRow('codex-legacy', 'codex', { CODEX_HOME: '/tmp/shared-codex' }, { enabled: 0 })

    expect(() => upsertProviderInstance({
      agentType: 'codex', displayName: 'Work', authMode: 'oauth_dir', oauthDir: '/tmp/shared-codex',
    })).not.toThrow()
  })

  it('reserves the canonical ~/.codex against an env overlay too', async () => {
    const { upsertProviderInstance } = await db()
    expect(() => upsertProviderInstance({
      agentType: 'codex', displayName: 'Hijack', authMode: 'env', env: { CODEX_HOME: CANONICAL_CODEX },
    })).toThrow(/reserved for the default Codex instance/)
  })

  it('lets the default codex row name its own canonical home', async () => {
    const { upsertProviderInstance } = await db()
    expect(() => upsertProviderInstance({
      id: 'codex-default', agentType: 'codex', displayName: 'Default',
      authMode: 'oauth_dir', oauthDir: CANONICAL_CODEX,
    })).not.toThrow()
  })

  it('reserves the canonical ~/.claude against a new oauth_dir row too', async () => {
    const { upsertProviderInstance } = await db()
    expect(() => upsertProviderInstance({
      agentType: 'claude-code', displayName: 'Hijack', authMode: 'oauth_dir', oauthDir: CANONICAL_CLAUDE,
    })).toThrow(/reserved for the default Claude instance/)
  })

  it('reserves the canonical ~/.claude against an env overlay too', async () => {
    const { upsertProviderInstance } = await db()
    expect(() => upsertProviderInstance({
      agentType: 'claude-code', displayName: 'Hijack', authMode: 'env', env: { CLAUDE_CONFIG_DIR: CANONICAL_CLAUDE },
    })).toThrow(/reserved for the default Claude instance/)
  })

  it('lets the default claude-code row name its own canonical home', async () => {
    const { upsertProviderInstance } = await db()
    expect(() => upsertProviderInstance({
      id: 'claude-code-default', agentType: 'claude-code', displayName: 'Default',
      authMode: 'oauth_dir', oauthDir: CANONICAL_CLAUDE,
    })).not.toThrow()
  })
})

describe('unchanged legacy rows keep saving (behavior 8)', () => {
  it('allows a cosmetic edit of a legacy non-default row already at ~/.codex', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({
      id: 'codex-legacy', agent_type: 'codex', display_name: 'Old Name',
      auth_mode: 'oauth_dir', oauth_dir: '~/.codex',
    })

    const saved = upsertProviderInstance({
      id: 'codex-legacy', agentType: 'codex', displayName: 'New Name', accentColor: '#abc',
    })
    expect(saved.displayName).toBe('New Name')
  })

  it('allows disabling such a row', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({ id: 'codex-legacy', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: CANONICAL_CODEX })

    expect(() => upsertProviderInstance({
      id: 'codex-legacy', agentType: 'codex', displayName: 'Legacy', enabled: false,
    })).not.toThrow()
  })

  it('still blocks MOVING a row onto the canonical home', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({ id: 'codex-work', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: '/tmp/codex-work' })

    expect(() => upsertProviderInstance({
      id: 'codex-work', agentType: 'codex', displayName: 'Work', authMode: 'oauth_dir', oauthDir: '~/.codex',
    })).toThrow(/reserved for the default Codex instance/)
  })

  it('still blocks a NEW row claiming the canonical home', async () => {
    const { upsertProviderInstance } = await db()
    expect(() => upsertProviderInstance({
      agentType: 'codex', displayName: 'Fresh', authMode: 'oauth_dir', oauthDir: CANONICAL_CODEX,
    })).toThrow(/reserved for the default Codex instance/)
  })

  it('does not hold a cleared oauth_dir against a row being re-enabled', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({ id: 'codex-work', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: '/tmp/shared' })
    seedRow({ id: 'codex-old', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: '/tmp/shared', enabled: 0 })

    // Dropping back to env mode gives up the claim on /tmp/shared, so there
    // is nothing left to collide with codex-work.
    expect(() => upsertProviderInstance({
      id: 'codex-old', agentType: 'codex', displayName: 'Old',
      authMode: 'env', oauthDir: null, enabled: true,
    })).not.toThrow()
  })

  it('still blocks re-enabling a disabled row that sits on another live profile dir', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({ id: 'codex-work', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: '/tmp/shared' })
    seedRow({ id: 'codex-old', agent_type: 'codex', auth_mode: 'oauth_dir', oauth_dir: '/tmp/shared', enabled: 0 })

    expect(() => upsertProviderInstance({
      id: 'codex-old', agentType: 'codex', displayName: 'Old', enabled: true,
    })).toThrow(/already used by instance codex-work/)
  })
})

describe('unchanged legacy Claude rows keep saving, same as Codex (behavior 8 symmetry)', () => {
  it('allows a cosmetic edit of a legacy non-default claude row already at ~/.claude', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({
      id: 'claude-legacy', agent_type: 'claude-code', display_name: 'Old Name',
      auth_mode: 'oauth_dir', oauth_dir: '~/.claude',
    })

    const saved = upsertProviderInstance({
      id: 'claude-legacy', agentType: 'claude-code', displayName: 'New Name', accentColor: '#abc',
    })
    expect(saved.displayName).toBe('New Name')
  })

  it('allows disabling such a row', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({ id: 'claude-legacy', agent_type: 'claude-code', auth_mode: 'oauth_dir', oauth_dir: CANONICAL_CLAUDE })

    expect(() => upsertProviderInstance({
      id: 'claude-legacy', agentType: 'claude-code', displayName: 'Legacy', enabled: false,
    })).not.toThrow()
  })

  it('still blocks MOVING a claude row onto the canonical home', async () => {
    const { upsertProviderInstance } = await db()
    seedRow({ id: 'claude-work', agent_type: 'claude-code', auth_mode: 'oauth_dir', oauth_dir: '/tmp/claude-work' })

    expect(() => upsertProviderInstance({
      id: 'claude-work', agentType: 'claude-code', displayName: 'Work', authMode: 'oauth_dir', oauthDir: '~/.claude',
    })).toThrow(/reserved for the default Claude instance/)
  })

  it('still blocks a NEW claude row claiming the canonical home', async () => {
    const { upsertProviderInstance } = await db()
    expect(() => upsertProviderInstance({
      agentType: 'claude-code', displayName: 'Fresh', authMode: 'oauth_dir', oauthDir: CANONICAL_CLAUDE,
    })).toThrow(/reserved for the default Claude instance/)
  })
})

/**
 * Behavior 9: a save must never SILENTLY drop the credential home a row
 * keeps in its env overlay.
 *
 * The overlay home is account identity (rule 2 of credential-home.ts), and
 * behavior 8 above advertises that an unchanged legacy row stays editable in
 * Settings "without forcing a relocation first". But the Settings dialog
 * cannot re-send env VALUES it never received - it prefills the key list with
 * blanks and sends only the rows the user actually typed into - so an
 * ordinary rename arrives as `env: {}`. Replacing the whole blob with that
 * erased `CODEX_HOME`/`CLAUDE_CONFIG_DIR`, and from the next spawn on the
 * profile ran against the SHARED canonical default: the advertised repair
 * action silently repointed the user at the default account, with the UI
 * still showing the profile they had picked.
 *
 * So the structural home var is pinned in the backend, where every caller
 * (Settings, IPC, a future remote client) passes through it, rather than in
 * the one renderer that happens to be careless: an update carries the stored
 * home forward whenever the incoming map OMITS that key. Naming the key
 * explicitly still repoints it, and naming it blank still clears it - the
 * only way to move an env-mode row back onto the default is to say so.
 *
 * Deliberately narrow: every OTHER key still follows the documented
 * "`{}` clears, `null` keeps" contract. Only the home is identity.
 */
describe('overlay credential home survives an unrelated save (behavior 9)', () => {
  // canonicalizeOauthPath runs every home through node:path's normalize(),
  // which is platform-native by design; the `effectiveOauthDir` assertions
  // below assert an exact POSIX-literal string round-trip, which only holds
  // on a POSIX host - skip on win32 rather than assert a separator style no
  // real Windows install would produce either (see oauth-path.ts). The raw
  // `.env.CODEX_HOME`/`.env.CLAUDE_CONFIG_DIR` assertions this test also
  // makes are unaffected (they read the uncanonicalized stored value).
  it.skipIf(process.platform === 'win32')('keeps a legacy CODEX_HOME when a rename sends an empty env map', async () => {
    const { upsertProviderInstance, getProviderInstanceFull } = await db()
    envRow('codex-legacy', 'codex', { CODEX_HOME: '/tmp/codex-work' }, { display_name: 'Old Name' })

    const saved = upsertProviderInstance({
      id: 'codex-legacy', agentType: 'codex', displayName: 'New Name', authMode: 'env', env: {},
    })

    expect(getProviderInstanceFull('codex-legacy')!.env.CODEX_HOME).toBe('/tmp/codex-work')
    expect(saved.displayName).toBe('New Name')
    expect(saved.envKeys).toContain('CODEX_HOME')
    expect(saved.effectiveOauthDir).toBe('/tmp/codex-work')
    expect(saved.effectiveOauthDirSource).toBe('env')
  })

  // Same POSIX-literal-fixture caveat as above.
  it.skipIf(process.platform === 'win32')('keeps a legacy CLAUDE_CONFIG_DIR the same way', async () => {
    const { upsertProviderInstance, getProviderInstanceFull } = await db()
    envRow('claude-legacy', 'claude-code', { CLAUDE_CONFIG_DIR: '/tmp/claude-work' })

    const saved = upsertProviderInstance({
      id: 'claude-legacy', agentType: 'claude-code', displayName: 'Renamed', authMode: 'env', env: {},
    })

    expect(getProviderInstanceFull('claude-legacy')!.env.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-work')
    expect(saved.effectiveOauthDir).toBe('/tmp/claude-work')
  })

  it('keeps a home hidden in a pre-env_keys encrypted blob, which cannot be ruled out', async () => {
    process.env.SWITCHBOARD_SECRET = 'behavior-9-secret'
    try {
      const { upsertProviderInstance, getProviderInstanceFull, encryptEnv } = await db()
      seedRow({
        id: 'codex-ancient', agent_type: 'codex', auth_mode: 'env',
        env_encrypted: encryptEnv({ CODEX_HOME: '/tmp/codex-ancient', OPENAI_API_KEY: 'sk-x' }),
        env_keys: null, // predates the env_keys column: presence is 'unknown'
      })

      upsertProviderInstance({
        id: 'codex-ancient', agentType: 'codex', displayName: 'Renamed', authMode: 'env', env: {},
      })

      expect(getProviderInstanceFull('codex-ancient')!.env.CODEX_HOME).toBe('/tmp/codex-ancient')
    } finally {
      delete process.env.SWITCHBOARD_SECRET
    }
  })

  it('refuses the save instead of repointing when the stored overlay cannot be read', async () => {
    const { upsertProviderInstance, encryptEnv } = await db()
    process.env.SWITCHBOARD_SECRET = 'write-only-secret'
    const blob = encryptEnv({ CODEX_HOME: '/tmp/codex-sealed' })
    delete process.env.SWITCHBOARD_SECRET // the key is gone: the blob is opaque now

    seedRow({
      id: 'codex-sealed', agent_type: 'codex', auth_mode: 'env',
      env_encrypted: blob, env_keys: JSON.stringify(['CODEX_HOME']),
    })

    expect(() => upsertProviderInstance({
      id: 'codex-sealed', agentType: 'codex', displayName: 'Renamed', authMode: 'env', env: {},
    })).toThrow(/credential home/i)
  })

  // Same POSIX-literal-fixture caveat as above.
  it.skipIf(process.platform === 'win32')('still repoints the home when the save names the key explicitly', async () => {
    const { upsertProviderInstance, getProviderInstanceFull } = await db()
    envRow('codex-legacy', 'codex', { CODEX_HOME: '/tmp/codex-work' })

    const saved = upsertProviderInstance({
      id: 'codex-legacy', agentType: 'codex', displayName: 'Legacy', authMode: 'env',
      env: { CODEX_HOME: '/tmp/codex-moved' },
    })

    expect(getProviderInstanceFull('codex-legacy')!.env.CODEX_HOME).toBe('/tmp/codex-moved')
    expect(saved.effectiveOauthDir).toBe('/tmp/codex-moved')
  })

  it('still clears the home when the save names the key blank', async () => {
    const { upsertProviderInstance, getProviderInstanceFull } = await db()
    envRow('codex-legacy', 'codex', { CODEX_HOME: '/tmp/codex-work' })

    upsertProviderInstance({
      id: 'codex-legacy', agentType: 'codex', displayName: 'Legacy', authMode: 'env',
      env: { CODEX_HOME: '' },
    })

    expect(getProviderInstanceFull('codex-legacy')!.env.CODEX_HOME).toBe('')
  })

  it('pins only the home - every other key still follows the documented clear-on-{} contract', async () => {
    const { upsertProviderInstance, getProviderInstanceFull } = await db()
    envRow('codex-legacy', 'codex', { CODEX_HOME: '/tmp/codex-work', OPENAI_API_KEY: 'sk-old' })

    const saved = upsertProviderInstance({
      id: 'codex-legacy', agentType: 'codex', displayName: 'Legacy', authMode: 'env', env: {},
    })

    expect(getProviderInstanceFull('codex-legacy')!.env).toEqual({ CODEX_HOME: '/tmp/codex-work' })
    expect(saved.envKeys).toEqual(['CODEX_HOME'])
  })

  it('leaves the whole blob alone for env: null, as before', async () => {
    const { upsertProviderInstance, getProviderInstanceFull } = await db()
    envRow('codex-legacy', 'codex', { CODEX_HOME: '/tmp/codex-work', OPENAI_API_KEY: 'sk-old' })

    upsertProviderInstance({
      id: 'codex-legacy', agentType: 'codex', displayName: 'Legacy', env: null,
    })

    expect(getProviderInstanceFull('codex-legacy')!.env)
      .toEqual({ CODEX_HOME: '/tmp/codex-work', OPENAI_API_KEY: 'sk-old' })
  })

  it('lets a legacy row already on the reserved canonical home be renamed, keeping it', async () => {
    const { upsertProviderInstance, getProviderInstanceFull } = await db()
    envRow('codex-legacy', 'codex', { CODEX_HOME: CANONICAL_CODEX })

    expect(() => upsertProviderInstance({
      id: 'codex-legacy', agentType: 'codex', displayName: 'Renamed', authMode: 'env', env: {},
    })).not.toThrow()
    expect(getProviderInstanceFull('codex-legacy')!.env.CODEX_HOME).toBe(CANONICAL_CODEX)
  })

  it('keeps the carried-forward home visible to validation - another row still cannot claim it', async () => {
    const { upsertProviderInstance } = await db()
    envRow('codex-legacy', 'codex', { CODEX_HOME: '/tmp/codex-work' })

    upsertProviderInstance({
      id: 'codex-legacy', agentType: 'codex', displayName: 'Renamed', authMode: 'env', env: {},
    })

    expect(() => upsertProviderInstance({
      agentType: 'codex', displayName: 'Impostor', authMode: 'oauth_dir', oauthDir: '/tmp/codex-work',
    })).toThrow(/already used by instance codex-legacy/)
  })

  it('ignores a cross-kind var - a stray CODEX_HOME on a claude row is ordinary env', async () => {
    const { upsertProviderInstance, getProviderInstanceFull } = await db()
    envRow('claude-legacy', 'claude-code', { CODEX_HOME: '/tmp/not-a-home' })

    upsertProviderInstance({
      id: 'claude-legacy', agentType: 'claude-code', displayName: 'Renamed', authMode: 'env', env: {},
    })

    expect(getProviderInstanceFull('claude-legacy')!.env).toEqual({})
  })
})
