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

// ─── safeStorage mock ──────────────────────────────────────────
let safeStorageAvailable = true
const safeStoragePrefix = Buffer.from([0xAA, 0xBB])

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/switchboard-vitest' },
  safeStorage: {
    isEncryptionAvailable: () => safeStorageAvailable,
    encryptString: (s: string) =>
      Buffer.concat([safeStoragePrefix, Buffer.from(s, 'utf-8')]),
    decryptString: (buf: Buffer) => {
      if (!buf.subarray(0, safeStoragePrefix.length).equals(safeStoragePrefix)) {
        throw new Error('mock safeStorage: bad ciphertext')
      }
      return buf.subarray(safeStoragePrefix.length).toString('utf-8')
    },
  },
}))

// ─── tiny in-memory store ──────────────────────────────────────
interface Row {
  id: string
  agent_type: string
  display_name: string
  accent_color: string | null
  auth_mode: string
  env_encrypted: Buffer | null
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
      oauth_dir: null,
      config_json: null,
      enabled: 1,
      created_at: t,
      updated_at: t,
    })
  }
}

// SQL pattern matcher — tied to providerInstances.ts queries.
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
          env_encrypted, oauth_dir, config_json, enabled, created_at, updated_at,
        ] = args as [string, string, string, string | null, string, Buffer | null, string | null, string | null, number, number, number]
        store.set(id, {
          id, agent_type, display_name, accent_color, auth_mode,
          env_encrypted, oauth_dir, config_json, enabled, created_at, updated_at,
        })
        return { changes: 1 }
      }
      if (norm.startsWith('UPDATE provider_instances SET display_name')) {
        const [name, accent, auth, env, oauthDir, config, enabled, updated, id] = args as [string, string | null, string, Buffer | null, string | null, string | null, number, number, string]
        const r = store.get(id)
        if (!r) return { changes: 0 }
        Object.assign(r, {
          display_name: name,
          accent_color: accent,
          auth_mode: auth,
          env_encrypted: env,
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
})

async function loadModule() {
  return import('../../src/main/db/providerInstances')
}

describe('encryptEnv / decryptEnv', () => {
  it('round-trips through safeStorage with the magic prefix', async () => {
    const { encryptEnv, decryptEnv } = await loadModule()
    const plain = { ANTHROPIC_API_KEY: 'sk-test-123', NVIDIA_API_KEY: 'nv-456' }
    const blob = encryptEnv(plain)
    expect(blob[0]).toBe(0x00) // sentinel byte — invalid UTF-8 JSON start
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

  it('returns {} for null / empty blobs', async () => {
    const { decryptEnv } = await loadModule()
    expect(decryptEnv(null)).toEqual({})
    expect(decryptEnv(Buffer.alloc(0))).toEqual({})
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

  it('falls back to default when id belongs to a different kind', async () => {
    const { upsertProviderInstance, resolveProviderInstance } = await loadModule()
    const codexInst = upsertProviderInstance({ agentType: 'codex', displayName: 'Codex Work' })
    expect(resolveProviderInstance('claude-code', codexInst.id)?.id).toBe('claude-code-default')
  })

  it('falls back to any enabled instance if the seed default is gone', async () => {
    const { upsertProviderInstance, resolveProviderInstance } = await loadModule()
    const other = upsertProviderInstance({ agentType: 'opencode', displayName: 'Custom' })
    store.delete('opencode-default')
    expect(resolveProviderInstance('opencode', null)?.id).toBe(other.id)
  })

  it('skips a disabled instance and falls back to default', async () => {
    const { upsertProviderInstance, resolveProviderInstance } = await loadModule()
    const inst = upsertProviderInstance({
      agentType: 'codex',
      displayName: 'Disabled',
      enabled: false,
    })
    expect(resolveProviderInstance('codex', inst.id)?.id).toBe('codex-default')
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
