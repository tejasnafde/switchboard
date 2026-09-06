/**
 * Provider-instances DB layer:
 *   - encryptEnv/decryptEnv round-trip (encrypted + plaintext fallback)
 *   - resolveProviderInstance fallback chain
 *   - deleteProviderInstance refusing the last instance
 *   - upsertProviderInstance rejecting unknown agent kinds
 *
 * better-sqlite3's prebuilt binary is built against Electron's Node ABI
 * and does not load under the host Node that runs vitest, so this file
 * mocks `'../../src/main/db/database'` with a minimal in-memory store.
 * The mock implements only the prepared-statement shapes that
 * providerInstances.ts uses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── safeStorage mock (via the runtime shim) ───────────────────
let safeStorageAvailable = true
const safeStoragePrefix = Buffer.from([0xAA, 0xBB])

vi.mock('../../src/main/runtime', () => ({
  isElectron: false,
  userDataDir: () => '/tmp/switchboard-vitest',
  appRootDir: () => '/tmp/switchboard-vitest',
  getSafeStorage: () =>
    safeStorageAvailable
      ? {
          isEncryptionAvailable: () => true,
          encryptString: (s: string) => Buffer.concat([safeStoragePrefix, Buffer.from(s, 'utf-8')]),
          decryptString: (buf: Buffer) => {
            if (!buf.subarray(0, safeStoragePrefix.length).equals(safeStoragePrefix)) {
              throw new Error('mock safeStorage: bad ciphertext')
            }
            return buf.subarray(safeStoragePrefix.length).toString('utf-8')
          },
        }
      : null,
}))

// ─── tiny in-memory store ──────────────────────────────────────
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

function seedDefaults() {
  store.clear()
  const t = Date.now()
  for (const k of ['claude-code', 'codex', 'opencode']) {
    store.set(`${k}-default`, {
      id: `${k}-default`,
      agent_type: k,
      display_name: 'Default',
      accent_color: null,
      auth_mode: 'env',
      env_encrypted: null,
      env_keys: null,
      oauth_dir: null,
      config_json: null,
      enabled: 1,
      created_at: t,
      updated_at: t,
    })
  }
}

// SQL pattern matcher - tied to providerInstances.ts queries.
function prepare(sql: string) {
  const norm = sql.replace(/\s+/g, ' ').trim()
  return {
    get: (...args: unknown[]) => {
      if (norm.startsWith('SELECT * FROM provider_instances WHERE id = ?')) {
        return store.get(args[0] as string)
      }
      if (norm.startsWith('SELECT agent_type FROM provider_instances WHERE id = ?')) {
        const r = store.get(args[0] as string)
        return r ? { agent_type: r.agent_type } : undefined
      }
      if (norm.startsWith('SELECT count(*) AS c FROM provider_instances WHERE agent_type = ? AND id != ?')) {
        const c = [...store.values()].filter(
          (r) => r.agent_type === args[0] && r.id !== args[1],
        ).length
        return { c }
      }
      if (norm.startsWith('SELECT * FROM provider_instances WHERE agent_type = ? AND enabled = 1 ORDER BY created_at ASC LIMIT 1')) {
        return [...store.values()]
          .filter((r) => r.agent_type === args[0] && r.enabled === 1)
          .sort((a, b) => a.created_at - b.created_at)[0]
      }
      throw new Error(`mock get: unhandled SQL: ${norm}`)
    },
    all: (..._args: unknown[]) => {
      if (norm.startsWith('SELECT * FROM provider_instances ORDER BY agent_type ASC, created_at ASC')) {
        return [...store.values()].sort(
          (a, b) =>
            a.agent_type.localeCompare(b.agent_type) || a.created_at - b.created_at,
        )
      }
      throw new Error(`mock all: unhandled SQL: ${norm}`)
    },
    run: (...args: unknown[]) => {
      if (norm.startsWith('INSERT INTO provider_instances')) {
        const [
          id, agent_type, display_name, accent_color, auth_mode,
          env_encrypted, env_keys, oauth_dir, config_json, enabled, created_at, updated_at,
        ] = args as [string, string, string, string | null, string, Buffer | null, string | null, string | null, string | null, number, number, number]
        store.set(id, {
          id, agent_type, display_name, accent_color, auth_mode,
          env_encrypted, env_keys, oauth_dir, config_json, enabled, created_at, updated_at,
        })
        return { changes: 1 }
      }
      if (norm.startsWith('UPDATE provider_instances SET display_name')) {
        const [name, accent, auth, env, envKeys, oauthDir, config, enabled, updated, id] = args as [string, string | null, string, Buffer | null, string | null, string | null, string | null, number, number, string]
        const r = store.get(id)
        if (!r) return { changes: 0 }
        Object.assign(r, {
          display_name: name,
          accent_color: accent,
          auth_mode: auth,
          env_encrypted: env,
          env_keys: envKeys,
          oauth_dir: oauthDir,
          config_json: config,
          enabled,
          updated_at: updated,
        })
        return { changes: 1 }
      }
      if (norm.startsWith('DELETE FROM provider_instances WHERE id = ?')) {
        const id = args[0] as string
        const had = store.delete(id)
        return { changes: had ? 1 : 0 }
      }
      throw new Error(`mock run: unhandled SQL: ${norm}`)
    },
  }
}

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({ prepare }),
}))

beforeEach(() => {
  seedDefaults()
  safeStorageAvailable = true
  delete process.env.SWITCHBOARD_SECRET
})

async function loadModule() {
  return import('../../src/main/db/providerInstances')
}

describe('encryptEnv / decryptEnv', () => {
  it('round-trips through safeStorage with the magic prefix', async () => {
    const { encryptEnv, decryptEnv } = await loadModule()
    const plain = { ANTHROPIC_API_KEY: 'sk-test-123', NVIDIA_API_KEY: 'nv-456' }
    const blob = encryptEnv(plain)
    expect(blob[0]).toBe(0x00) // sentinel byte - invalid UTF-8 JSON start
    expect(decryptEnv(blob)).toEqual(plain)
  })

  it('falls back to plaintext when safeStorage is unavailable', async () => {
    safeStorageAvailable = false
    const { encryptEnv, decryptEnv } = await loadModule()
    const plain = { OPENAI_API_KEY: 'sk-plain' }
    const blob = encryptEnv(plain)
    expect(blob.toString('utf-8')).toBe(JSON.stringify(plain))
    expect(decryptEnv(blob)).toEqual(plain)
  })

  it('returns {} when an encrypted blob is read with safeStorage unavailable', async () => {
    const { encryptEnv, decryptEnv } = await loadModule()
    const blob = encryptEnv({ K: 'v' })
    safeStorageAvailable = false
    expect(decryptEnv(blob)).toEqual({})
  })

  // Headless backend: no keychain, but SWITCHBOARD_SECRET set → passphrase AES.
  it('round-trips via SWITCHBOARD_SECRET when safeStorage is unavailable', async () => {
    safeStorageAvailable = false
    process.env.SWITCHBOARD_SECRET = 'correct horse battery staple'
    const { encryptEnv, decryptEnv } = await loadModule()
    const plain = { ANTHROPIC_API_KEY: 'sk-headless' }
    const blob = encryptEnv(plain)
    expect(blob[0]).toBe(0x00) // sentinel - not plaintext
    expect(blob.toString('utf-8')).not.toContain('sk-headless') // actually encrypted
    expect(decryptEnv(blob)).toEqual(plain)
  })

  it('returns {} for a passphrase blob when SWITCHBOARD_SECRET is missing', async () => {
    safeStorageAvailable = false
    process.env.SWITCHBOARD_SECRET = 'a-secret'
    const { encryptEnv, decryptEnv } = await loadModule()
    const blob = encryptEnv({ K: 'v' })
    delete process.env.SWITCHBOARD_SECRET
    expect(decryptEnv(blob)).toEqual({})
  })

  it('returns {} for null / empty blobs', async () => {
    const { decryptEnv } = await loadModule()
    expect(decryptEnv(null)).toEqual({})
    expect(decryptEnv(Buffer.alloc(0))).toEqual({})
  })
})

describe('expandTilde (behavior 2 - normalizes absolute paths too)', () => {
  it('collapses redundant `..`/`//` segments in a non-tilde absolute path', async () => {
    const { expandTilde } = await loadModule()
    // No leading `~`, so today's implementation returns the path verbatim -
    // a redundant absolute path (as users paste from Finder "Copy as Pathname"
    // or a shell with a trailing slash) is stored un-normalized.
    expect(expandTilde('/tmp/codex-home/../codex-home2//sub')).toBe('/tmp/codex-home2/sub')
  })
})

// Item 4 (wire canonicalization): the wire row's `oauthDir` is deliberately
// the literal the user typed (see rowToWire's comment), so a messy literal
// (`..`, `//`, an un-expanded `~`) must not be the ONLY thing Settings has to
// show as "the credential home in use" - that string can differ from the
// canonical absolute directory every consumer (resolveInstanceEnv, the
// oauth_dir uniqueness check, the spawn env) actually resolves it to.
// `effectiveOauthDir` is the backend-authoritative canonical directory,
// computed with the exact same `canonicalizeOauthPath` used everywhere else,
// so Settings can display the real directory without recomputing (and
// potentially drifting from) that logic client-side.
describe('listProviderInstances - wire canonicalization (item 4)', () => {
  it('exposes effectiveOauthDir as the canonical directory, distinct from the literal oauthDir', async () => {
    const { upsertProviderInstance, listProviderInstances, expandTilde } = await loadModule()
    const messyLiteral = '~/.codex-work/../.codex-work2'
    upsertProviderInstance({
      agentType: 'codex',
      displayName: 'Messy Path',
      authMode: 'oauth_dir',
      oauthDir: messyLiteral,
    })
    const wire = listProviderInstances().find((i) => i.displayName === 'Messy Path')
    expect(wire?.oauthDir).toBe(messyLiteral)
    expect(wire?.effectiveOauthDir).toBe(expandTilde(messyLiteral))
    expect(wire?.effectiveOauthDir).not.toBe(messyLiteral)
  })

  it('exposes the canonical ~/.codex default as effectiveOauthDir when a codex row has no oauth_dir', async () => {
    const { listProviderInstances, expandTilde } = await loadModule()
    const wire = listProviderInstances().find((i) => i.id === 'codex-default')
    expect(wire?.oauthDir).toBeNull()
    expect(wire?.effectiveOauthDir).toBe(expandTilde('~/.codex'))
  })
})

describe('upsertProviderInstance - oauth_dir validation (behavior 4)', () => {
  it('rejects an empty/blank oauth_dir path when authMode is oauth_dir', async () => {
    const { upsertProviderInstance } = await loadModule()
    expect(() => upsertProviderInstance({
      agentType: 'codex',
      displayName: 'Empty Path',
      authMode: 'oauth_dir',
      oauthDir: '   ',
    })).toThrow(/oauth.?dir|path/i)
  })

  it('rejects a duplicate effective oauth_dir among enabled codex rows', async () => {
    const { upsertProviderInstance } = await loadModule()
    upsertProviderInstance({
      agentType: 'codex',
      displayName: 'Work',
      authMode: 'oauth_dir',
      oauthDir: '/tmp/codex-shared',
    })
    expect(() => upsertProviderInstance({
      agentType: 'codex',
      displayName: 'Duplicate',
      authMode: 'oauth_dir',
      oauthDir: '/tmp/codex-shared',
    })).toThrow(/duplicate|already (used|in use)/i)
  })

  it('reserves the canonical ~/.codex dir to the default row', async () => {
    const { upsertProviderInstance } = await loadModule()
    expect(() => upsertProviderInstance({
      agentType: 'codex',
      displayName: 'Impersonator',
      authMode: 'oauth_dir',
      oauthDir: '~/.codex',
    })).toThrow(/reserved|default/i)
  })
})

describe('upsertProviderInstance', () => {
  it('rejects unknown agentType', async () => {
    const { upsertProviderInstance } = await loadModule()
    expect(() =>
      upsertProviderInstance({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agentType: 'malicious-kind' as any,
        displayName: 'Evil',
      }),
    ).toThrow(/unknown agentType/)
  })

  it('persists env via encrypt path; wire shape exposes only envKeys', async () => {
    const { upsertProviderInstance, getProviderInstanceFull } = await loadModule()
    const wire = upsertProviderInstance({
      agentType: 'codex',
      displayName: 'Work',
      env: { CODEX_TOKEN: 'secret-789' },
    })
    expect(wire.envKeys).toEqual(['CODEX_TOKEN'])
    expect('env' in wire).toBe(false)
    const full = getProviderInstanceFull(wire.id)
    expect(full?.env).toEqual({ CODEX_TOKEN: 'secret-789' })
  })

  it('LIST returns envKeys without touching decryption (keychain-free boot path)', async () => {
    const { upsertProviderInstance, listProviderInstances } = await loadModule()
    upsertProviderInstance({
      agentType: 'codex',
      displayName: 'Work',
      env: { CODEX_TOKEN: 'secret-789', OPENAI_API_KEY: 'sk-x' },
    })
    // Simulate the unsigned-build scenario: safeStorage gone at read time.
    // Before the env_keys column, LIST decrypted every row and this returned []
    // (and on real macOS, prompted for the login password at every launch).
    safeStorageAvailable = false
    const listed = listProviderInstances().find((i) => i.displayName === 'Work')
    expect(listed?.envKeys).toEqual(['CODEX_TOKEN', 'OPENAI_API_KEY'])
  })
})

describe('resolveProviderInstance', () => {
  it('returns the exact instance when id matches the agent kind', async () => {
    const { upsertProviderInstance, resolveProviderInstance } = await loadModule()
    const inst = upsertProviderInstance({
      agentType: 'claude-code',
      displayName: 'Work',
      env: { ANTHROPIC_API_KEY: 'sk-work' },
    })
    const r = resolveProviderInstance('claude-code', inst.id)
    expect(r?.id).toBe(inst.id)
    expect(r?.env.ANTHROPIC_API_KEY).toBe('sk-work')
  })

  it('falls back to <kind>-default when id is missing', async () => {
    const { resolveProviderInstance } = await loadModule()
    expect(resolveProviderInstance('codex', null)?.id).toBe('codex-default')
  })

  // Behavior 5: an EXPLICITLY requested instance id that turns out to be the
  // wrong kind must fail loudly, not silently substitute the default profile
  // (a Codex credential handed a Claude-scoped instance id must never run
  // Claude turns against someone else's Claude account).
  it('behavior 5: throws when an explicitly requested id belongs to a different kind', async () => {
    const { upsertProviderInstance, resolveProviderInstance } = await loadModule()
    const codexInst = upsertProviderInstance({ agentType: 'codex', displayName: 'Codex Work' })
    expect(() => resolveProviderInstance('claude-code', codexInst.id)).toThrow(/wrong kind|not found|invalid instance/i)
  })

  it('falls back to any enabled instance if the seed default is gone', async () => {
    const { upsertProviderInstance, resolveProviderInstance } = await loadModule()
    const other = upsertProviderInstance({ agentType: 'opencode', displayName: 'Custom' })
    store.delete('opencode-default')
    expect(resolveProviderInstance('opencode', null)?.id).toBe(other.id)
  })

  it('behavior 5: throws when an explicitly requested instance is disabled', async () => {
    const { upsertProviderInstance, resolveProviderInstance } = await loadModule()
    const inst = upsertProviderInstance({
      agentType: 'codex',
      displayName: 'Disabled',
      enabled: false,
    })
    expect(() => resolveProviderInstance('codex', inst.id)).toThrow(/disabled|not found|invalid instance/i)
  })

  it('behavior 5: throws when an explicitly requested id does not exist at all', async () => {
    const { resolveProviderInstance } = await loadModule()
    expect(() => resolveProviderInstance('codex', 'no-such-instance-id')).toThrow(/not found|invalid instance/i)
  })

  // Implicit resolution (no id given at all) is unaffected by behavior 5 -
  // it may still choose a valid default. Re-asserted here so a fix that
  // makes resolveProviderInstance throw does not also break the plain
  // "nothing requested yet" path these two already covered above.
  it('behavior 5: implicit (no id) resolution still falls back to default, unaffected', async () => {
    const { resolveProviderInstance } = await loadModule()
    expect(() => resolveProviderInstance('codex', null)).not.toThrow()
    expect(resolveProviderInstance('codex', undefined)?.id).toBe('codex-default')
  })
})

describe('deleteProviderInstance', () => {
  it('refuses to delete the last instance for an agent kind', async () => {
    const { deleteProviderInstance } = await loadModule()
    expect(deleteProviderInstance('codex-default')).toBe(false)
    expect(store.has('codex-default')).toBe(true)
  })

  it('allows deleting when at least one other instance remains', async () => {
    const { upsertProviderInstance, deleteProviderInstance } = await loadModule()
    const extra = upsertProviderInstance({ agentType: 'codex', displayName: 'Extra' })
    expect(deleteProviderInstance(extra.id)).toBe(true)
    expect(deleteProviderInstance('codex-default')).toBe(false)
  })

  it('returns false for unknown ids', async () => {
    const { deleteProviderInstance } = await loadModule()
    expect(deleteProviderInstance('does-not-exist')).toBe(false)
  })
})
