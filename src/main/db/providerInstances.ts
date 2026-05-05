/**
 * Provider instances — CRUD + safeStorage encryption.
 *
 * Each "instance" is a named credential set scoped to an agent kind
 * (claude-code / codex / opencode). The user can create multiple
 * instances per kind ("Work Codex", "Personal Codex") and pick one per
 * session. At spawn time, the registry resolves the instance row,
 * decrypts `env_encrypted`, and merges into the adapter env.
 *
 * Sensitive env values (API keys, OAuth tokens) are protected by
 * Electron `safeStorage` (Keychain on macOS). When safeStorage is not
 * available (Linux without keyring), we log a warning and write the
 * plaintext JSON into the same BLOB column — the schema still works
 * and the user is no worse off than the existing `opencode.env.*`
 * settings keys (which are plaintext today).
 */

import { safeStorage } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { getDb } from './database'
import { createMainLogger as createLogger } from '../logger'
import { isAgentType, defaultInstanceId, type AgentType } from '@shared/types'

/**
 * Expand a leading `~` (or `~/`) to the user's home dir. Users routinely
 * type `~/.claude-foo` in the Settings → Providers oauth_dir field, but
 * neither Node's fs nor a spawned child's CLAUDE_CONFIG_DIR / CODEX_HOME
 * env vars do tilde expansion themselves — leaving the SDK to read from a
 * literal `~/.claude-foo` directory under cwd, which is never where the
 * user actually `claude login`'d.
 */
export function expandTilde(p: string | null): string | null {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

const log = createLogger('db:provider-instances')

export interface ProviderInstanceRow {
  id: string
  agentType: AgentType
  displayName: string
  accentColor: string | null
  /** 'env' = inject env vars at spawn. 'oauth_dir' = point CLAUDE_CONFIG_DIR
   *  / CODEX_HOME at a per-instance dir for OAuth multiplexing. */
  authMode: 'env' | 'oauth_dir'
  /** Decrypted env map (KEY → value). Empty for default-seeded rows. */
  env: Record<string, string>
  oauthDir: string | null
  configJson: unknown
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** Wire shape — no env decrypted, just keys + a `valueRedacted` flag.
 *  Sent to the renderer so the Settings UI can list instances and show
 *  which env vars are set without leaking the actual secrets. */
export interface ProviderInstanceWire {
  id: string
  agentType: AgentType
  displayName: string
  accentColor: string | null
  authMode: 'env' | 'oauth_dir'
  envKeys: string[]
  oauthDir: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

interface DbRow {
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

// 4-byte sentinel prefixed to safeStorage-encrypted blobs so we can
// distinguish them from the plaintext-JSON fallback unambiguously.
// Byte 0x00 is invalid in UTF-8 JSON, so any blob starting with this
// header is definitely not plaintext.
const ENC_MAGIC = Buffer.from([0x00, 0x53, 0x42, 0x45]) // \0SBE

function hasEncMagic(blob: Buffer): boolean {
  return blob.length >= ENC_MAGIC.length && blob.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)
}

export function decryptEnv(blob: Buffer | null): Record<string, string> {
  if (!blob || blob.length === 0) return {}
  if (hasEncMagic(blob)) {
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('encrypted env blob found but safeStorage is unavailable')
      return {}
    }
    try {
      const decoded = safeStorage.decryptString(blob.subarray(ENC_MAGIC.length))
      const parsed = JSON.parse(decoded)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
    } catch (err) {
      log.warn(`failed to decrypt env: ${err instanceof Error ? err.message : String(err)}`)
    }
    return {}
  }
  // Plaintext-JSON fallback (Linux without keyring).
  try {
    const parsed = JSON.parse(blob.toString('utf-8'))
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
  } catch {}
  return {}
}

export function encryptEnv(env: Record<string, string>): Buffer {
  const json = JSON.stringify(env ?? {})
  if (safeStorage.isEncryptionAvailable()) {
    return Buffer.concat([ENC_MAGIC, safeStorage.encryptString(json)])
  }
  log.warn('safeStorage unavailable — falling back to plaintext storage for env vars')
  return Buffer.from(json, 'utf-8')
}

function rowToFull(r: DbRow): ProviderInstanceRow {
  let configJson: unknown = null
  if (r.config_json) {
    try { configJson = JSON.parse(r.config_json) } catch {}
  }
  return {
    id: r.id,
    agentType: r.agent_type as AgentType,
    displayName: r.display_name,
    accentColor: r.accent_color,
    authMode: r.auth_mode === 'oauth_dir' ? 'oauth_dir' : 'env',
    env: decryptEnv(r.env_encrypted),
    oauthDir: expandTilde(r.oauth_dir),
    configJson,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToWire(r: DbRow): ProviderInstanceWire {
  const env = decryptEnv(r.env_encrypted)
  return {
    id: r.id,
    agentType: r.agent_type as AgentType,
    displayName: r.display_name,
    accentColor: r.accent_color,
    authMode: r.auth_mode === 'oauth_dir' ? 'oauth_dir' : 'env',
    envKeys: Object.keys(env).sort(),
    oauthDir: r.oauth_dir,  // wire keeps the literal so the user sees what they typed
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listProviderInstances(): ProviderInstanceWire[] {
  const rows = getDb().prepare(
    'SELECT * FROM provider_instances ORDER BY agent_type ASC, created_at ASC'
  ).all() as DbRow[]
  return rows.map(rowToWire)
}

/** Internal — returns the full decrypted row. Used by the registry at
 *  session-start. NEVER expose this over IPC. */
export function getProviderInstanceFull(id: string): ProviderInstanceRow | null {
  const row = getDb().prepare(
    'SELECT * FROM provider_instances WHERE id = ?'
  ).get(id) as DbRow | undefined
  return row ? rowToFull(row) : null
}

export interface ProviderInstanceUpsertInput {
  /** When provided, update the row with this id; otherwise insert with a
   *  derived slug. */
  id?: string
  agentType: AgentType
  displayName: string
  accentColor?: string | null
  authMode?: 'env' | 'oauth_dir'
  /** Plaintext env map. The module encrypts before writing. Pass `null`
   *  to leave the existing env untouched on update; pass `{}` to clear. */
  env?: Record<string, string> | null
  oauthDir?: string | null
  configJson?: unknown
  enabled?: boolean
}

function deriveId(agentType: AgentType, displayName: string): string {
  const slug = displayName.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'instance'
  return `${agentType}-${slug}-${Math.random().toString(36).slice(2, 6)}`
}

export function upsertProviderInstance(input: ProviderInstanceUpsertInput): ProviderInstanceWire {
  if (!isAgentType(input.agentType)) {
    throw new Error(`upsertProviderInstance: unknown agentType ${JSON.stringify(input.agentType)}`)
  }
  const db = getDb()
  const now = Date.now()
  const existing = input.id
    ? db.prepare('SELECT * FROM provider_instances WHERE id = ?').get(input.id) as DbRow | undefined
    : undefined

  if (existing) {
    // Update path. `env: null` keeps existing encrypted blob untouched.
    const newEnv = input.env === null || input.env === undefined
      ? existing.env_encrypted
      : encryptEnv(input.env)
    const newAuth = input.authMode ?? existing.auth_mode
    const newName = input.displayName
    const newAccent = input.accentColor === undefined ? existing.accent_color : input.accentColor
    const newOauthDir = input.oauthDir === undefined ? existing.oauth_dir : input.oauthDir
    const newConfig = input.configJson === undefined
      ? existing.config_json
      : (input.configJson === null ? null : JSON.stringify(input.configJson))
    const newEnabled = input.enabled === undefined ? existing.enabled : (input.enabled ? 1 : 0)
    db.prepare(
      `UPDATE provider_instances
          SET display_name = ?, accent_color = ?, auth_mode = ?,
              env_encrypted = ?, oauth_dir = ?, config_json = ?,
              enabled = ?, updated_at = ?
        WHERE id = ?`
    ).run(newName, newAccent, newAuth, newEnv, newOauthDir, newConfig, newEnabled, now, existing.id)
    return rowToWire(db.prepare('SELECT * FROM provider_instances WHERE id = ?').get(existing.id) as DbRow)
  }

  // Insert path
  const id = input.id ?? deriveId(input.agentType, input.displayName)
  const env = input.env ? encryptEnv(input.env) : null
  const config = input.configJson === undefined || input.configJson === null
    ? null
    : JSON.stringify(input.configJson)
  db.prepare(
    `INSERT INTO provider_instances
       (id, agent_type, display_name, accent_color, auth_mode,
        env_encrypted, oauth_dir, config_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.agentType, input.displayName,
    input.accentColor ?? null,
    input.authMode ?? 'env',
    env,
    input.oauthDir ?? null,
    config,
    input.enabled === false ? 0 : 1,
    now, now,
  )
  return rowToWire(db.prepare('SELECT * FROM provider_instances WHERE id = ?').get(id) as DbRow)
}

export function deleteProviderInstance(id: string): boolean {
  // Refuse to delete the default-seeded row of an agent kind that has
  // no other instances — at least one must always exist so the picker
  // has something to fall back to.
  const row = getDb().prepare(
    'SELECT agent_type FROM provider_instances WHERE id = ?'
  ).get(id) as { agent_type: string } | undefined
  if (!row) return false
  const remaining = (getDb().prepare(
    'SELECT count(*) AS c FROM provider_instances WHERE agent_type = ? AND id != ?'
  ).get(row.agent_type, id) as { c: number }).c
  if (remaining === 0) {
    log.warn(`refusing to delete last instance for agent kind ${row.agent_type}`)
    return false
  }
  const result = getDb().prepare('DELETE FROM provider_instances WHERE id = ?').run(id)
  return result.changes > 0
}

/**
 * Resolve an instance for use at session start. Falls back to
 * `<agentType>-default` if the requested id is missing or null. Returns
 * null only if the agent kind has no instances at all (shouldn't happen
 * post-migration, but the caller handles it gracefully).
 */
/**
 * Return every enabled instance's resolved oauth_dir for the given agent
 * kind. Used by adapters to discover where a session JSONL lives across
 * profiles when the in-memory rotation tracker is cold (post-restart).
 */
export function listOauthDirsForAgent(agentType: AgentType): string[] {
  const rows = getDb().prepare(
    `SELECT oauth_dir FROM provider_instances
      WHERE agent_type = ? AND enabled = 1 AND oauth_dir IS NOT NULL AND oauth_dir != ''`
  ).all(agentType) as Array<{ oauth_dir: string | null }>
  const dirs = rows
    .map((r) => expandTilde(r.oauth_dir))
    .filter((d): d is string => !!d)
  return Array.from(new Set(dirs))
}

export function resolveProviderInstance(
  agentType: AgentType,
  instanceId: string | undefined | null,
): ProviderInstanceRow | null {
  if (instanceId) {
    const exact = getProviderInstanceFull(instanceId)
    if (exact && exact.agentType === agentType && exact.enabled) return exact
  }
  const fallback = getProviderInstanceFull(defaultInstanceId(agentType))
  if (fallback) return fallback
  // Last-ditch: any enabled instance of the right kind, oldest first.
  const row = getDb().prepare(
    `SELECT * FROM provider_instances
      WHERE agent_type = ? AND enabled = 1
      ORDER BY created_at ASC LIMIT 1`
  ).get(agentType) as DbRow | undefined
  return row ? rowToFull(row) : null
}
