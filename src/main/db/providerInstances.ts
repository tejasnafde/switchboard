/**
 * Provider instances - CRUD + safeStorage encryption.
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
 * plaintext JSON into the same BLOB column - the schema still works
 * and the user is no worse off than the existing `opencode.env.*`
 * settings keys (which are plaintext today).
 */

import { getSafeStorage } from '../runtime'
import { seal, unseal } from '../crypto/secret-box'
import { getDb } from './database'
import { createMainLogger as createLogger } from '../logger'
import { isAbsolute } from 'path'
import { isAgentType, defaultInstanceId, type AgentType, type EffectiveOauthDirSource } from '@shared/types'
import { canonicalizeOauthPath } from '../provider/oauth-path'
import {
  canonicalCredentialHome,
  credentialHomeEnvName,
  effectiveCredentialHome,
  resolvedCredentialHome,
  type CredentialHomeAgent,
} from '../provider/credential-home'

/** Human label for the reserved-canonical-home error, identical rule for
 *  both credential-bearing kinds (see validateCredentialHome). */
const AGENT_LABEL: Record<CredentialHomeAgent, string> = {
  codex: 'Codex',
  'claude-code': 'Claude',
}

/**
 * Expand a leading `~` (or `~/`) to the user's home dir AND collapse the path.
 * Users routinely type `~/.claude-foo` in the Settings → Providers oauth_dir
 * field, but neither Node's fs nor a spawned child's CLAUDE_CONFIG_DIR /
 * CODEX_HOME env vars do tilde expansion themselves - leaving the SDK to read
 * from a literal `~/.claude-foo` directory under cwd, which is never where
 * the user actually `claude login`'d.
 *
 * Absolute paths are normalized too. `/tmp/x/../x`, `/tmp/x//` and `/tmp/x`
 * are one directory but three strings, and a profile whose stored string
 * merely LOOKS different from another's is a profile that silently shares its
 * credentials with it. See `provider/oauth-path.ts`.
 */
export function expandTilde(p: string | null): string | null {
  if (!p) return p
  return canonicalizeOauthPath(p)
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

export type { EffectiveOauthDirSource }

/** Wire shape - no env decrypted, just keys + a `valueRedacted` flag.
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
  /**
   * The canonical absolute directory this instance's credential home
   * actually resolves to - the same value `resolveInstanceEnv` computes for
   * a real spawn, session start, Test probe and Usage probe. `oauthDir`
   * above is deliberately the raw literal the user typed (so the edit field
   * shows it unchanged); this field is what Settings must display as "the
   * directory in use", so a `..`/`//`/un-expanded `~` in the literal can
   * never make the UI claim a directory other than the one that really runs.
   *
   * Null ONLY when this layer cannot answer without decrypting (see
   * `effectiveOauthDirSource: 'unresolved'`) or when the agent kind has no
   * credential home at all. Never a guess.
   */
  effectiveOauthDir: string | null
  /**
   * Where `effectiveOauthDir` came from, so the UI can say so rather than
   * implying every profile is an oauth_dir one:
   *
   *   'oauth_dir'  - the row's own oauth_dir column
   *   'env'        - a CODEX_HOME/CLAUDE_CONFIG_DIR in the row's env overlay
   *                  (a legacy env-mode profile; still honored at spawn)
   *   'default'    - the CLI's canonical `~/.claude` / `~/.codex`
   *   'unresolved' - only the encrypted overlay could answer, and LIST does
   *                  not decrypt (that hits the OS keychain at every boot).
   *                  The main IPC layer replaces this before the renderer
   *                  sees it; a row that arrives still 'unresolved' means the
   *                  blob could not be read at all, and the UI must show
   *                  "unknown" rather than a directory that may be wrong.
   */
  effectiveOauthDirSource: EffectiveOauthDirSource
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
  env_keys: string | null
  oauth_dir: string | null
  config_json: string | null
  enabled: number
  created_at: number
  updated_at: number
}

// 4-byte sentinels prefixed to encrypted blobs so we can tell them apart from
// the plaintext-JSON fallback. Byte 0x00 is invalid in UTF-8 JSON, so any blob
// starting with one of these headers is definitely not plaintext.
//   ENC_MAGIC  - Electron safeStorage (desktop, OS keychain)
//   PASS_MAGIC - passphrase AES-256-GCM (headless backend, SWITCHBOARD_SECRET)
const ENC_MAGIC = Buffer.from([0x00, 0x53, 0x42, 0x45]) // \0SBE
const PASS_MAGIC = Buffer.from([0x00, 0x53, 0x42, 0x50]) // \0SBP

function hasMagic(blob: Buffer, magic: Buffer): boolean {
  return blob.length >= magic.length && blob.subarray(0, magic.length).equals(magic)
}

/**
 * Decrypt an env blob, or null when it CANNOT BE OPENED at all - no
 * keychain, wrong host, missing `SWITCHBOARD_SECRET`, corrupt ciphertext.
 *
 * `decryptEnv` below flattens that to `{}` for the many callers that just
 * want an env map to overlay. The callers that are about to OVERWRITE the
 * blob must tell the two apart: "this row has no credential home" and "this
 * row's credential home is unreadable right now" look identical as `{}`, and
 * acting on the first when it was really the second is how a save silently
 * repoints a profile at the shared default account (see `envToStore`).
 */
function decryptEnvOrNull(blob: Buffer | null): Record<string, string> | null {
  if (!blob || blob.length === 0) return {}
  if (hasMagic(blob, ENC_MAGIC)) {
    const safeStorage = getSafeStorage()
    if (!safeStorage?.isEncryptionAvailable()) {
      log.warn('safeStorage-encrypted env blob found but safeStorage is unavailable (wrong host?)')
      return null
    }
    try {
      return parseEnvOrNull(safeStorage.decryptString(blob.subarray(ENC_MAGIC.length)))
    } catch (err) {
      log.warn(`failed to decrypt env: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  if (hasMagic(blob, PASS_MAGIC)) {
    const secret = process.env.SWITCHBOARD_SECRET
    if (!secret) {
      log.warn('passphrase-encrypted env blob found but SWITCHBOARD_SECRET is unset')
      return null
    }
    try {
      return parseEnvOrNull(unseal(blob.subarray(PASS_MAGIC.length), secret))
    } catch (err) {
      log.warn(`failed to decrypt env: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  // Plaintext-JSON fallback (no keychain and no SWITCHBOARD_SECRET).
  return parseEnvOrNull(blob.toString('utf-8'))
}

export function decryptEnv(blob: Buffer | null): Record<string, string> {
  return decryptEnvOrNull(blob) ?? {}
}

function parseEnvOrNull(json: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
  } catch {
    /* malformed blob */
  }
  return null
}

function parseEnv(json: string): Record<string, string> {
  return parseEnvOrNull(json) ?? {}
}

export function encryptEnv(env: Record<string, string>): Buffer {
  const json = JSON.stringify(env ?? {})
  const safeStorage = getSafeStorage()
  if (safeStorage?.isEncryptionAvailable()) {
    return Buffer.concat([ENC_MAGIC, safeStorage.encryptString(json)])
  }
  const secret = process.env.SWITCHBOARD_SECRET
  if (secret) {
    return Buffer.concat([PASS_MAGIC, seal(json, secret)])
  }
  log.warn('no safeStorage and no SWITCHBOARD_SECRET - storing env vars as plaintext')
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

/** Key NAMES for the wire shape without touching env_encrypted - decrypting
 *  on LIST hit the macOS Keychain at every boot (password prompt on unsigned
 *  builds). Uses the plaintext env_keys column; legacy rows parse the blob
 *  only when it is plaintext, encrypted ones show [] until their next save. */
function envKeysNoDecrypt(r: DbRow): string[] {
  if (r.env_keys) {
    try {
      const parsed = JSON.parse(r.env_keys)
      if (Array.isArray(parsed)) return parsed.filter((k): k is string => typeof k === 'string')
    } catch { log.warn(`malformed env_keys for instance ${r.id}`) }
  }
  const blob = r.env_encrypted
  if (!blob || blob.length === 0) return []
  if (hasMagic(blob, ENC_MAGIC) || hasMagic(blob, PASS_MAGIC)) return []
  return Object.keys(parseEnv(blob.toString('utf-8'))).sort()
}

/** The agent kinds whose credentials live in a directory, or null. */
function credentialAgent(agentType: string): CredentialHomeAgent | null {
  return agentType === 'codex' || agentType === 'claude-code' ? agentType : null
}

/**
 * Whether this row's env overlay holds the structural home var for its kind,
 * decided WITHOUT decrypting:
 *   'absent'  - no overlay at all, or its key list proves the var is not there
 *   'present' - the key list says it is (the value still needs decrypting)
 *   'unknown' - an encrypted blob predating the env_keys column: could be
 *               anything, so nothing here may assume it is home-free
 */
function overlayHomeKeyPresence(r: DbRow, agent: CredentialHomeAgent): 'absent' | 'present' | 'unknown' {
  const blob = r.env_encrypted
  if (!blob || blob.length === 0) return 'absent'
  const key = credentialHomeEnvName(agent)
  if (r.env_keys) {
    try {
      const parsed = JSON.parse(r.env_keys)
      if (Array.isArray(parsed)) return parsed.includes(key) ? 'present' : 'absent'
    } catch { log.warn(`malformed env_keys for instance ${r.id}`) }
  }
  // Plaintext fallback blobs are readable without the keychain.
  if (!hasMagic(blob, ENC_MAGIC) && !hasMagic(blob, PASS_MAGIC)) {
    return key in parseEnv(blob.toString('utf-8')) ? 'present' : 'absent'
  }
  return 'unknown'
}

/** The home a row's env overlay declares, or null. Decrypts only when the
 *  key list cannot rule the var out. */
function overlayCredentialHome(r: DbRow, agent: CredentialHomeAgent): string | null {
  if (overlayHomeKeyPresence(r, agent) === 'absent') return null
  const overlay = decryptEnv(r.env_encrypted)[credentialHomeEnvName(agent)]
  return canonicalizeOauthPath(overlay) ? effectiveCredentialHome(agent, overlay) : null
}

/**
 * What the stored overlay says about this row's credential home:
 *   'absent'     - it holds none
 *   'value'      - it holds this one (blank included: a blank home is a
 *                  deliberate "use the default", not a missing answer)
 *   'unreadable' - the key list says it has one (or predates the key list, so
 *                  cannot rule one out) and the blob would not open
 */
type StoredOverlayHome =
  | { kind: 'absent' }
  | { kind: 'value'; value: string }
  | { kind: 'unreadable' }

function storedOverlayHome(r: DbRow, agent: CredentialHomeAgent): StoredOverlayHome {
  if (overlayHomeKeyPresence(r, agent) === 'absent') return { kind: 'absent' }
  const overlay = decryptEnvOrNull(r.env_encrypted)
  if (!overlay) return { kind: 'unreadable' }
  const name = credentialHomeEnvName(agent)
  return name in overlay ? { kind: 'value', value: overlay[name] } : { kind: 'absent' }
}

/**
 * The env map a save will REALLY store - resolved once, so validation and
 * the write can never disagree about the credential home.
 *
 * `null`/`undefined` still means "keep the stored blob" and a map still
 * replaces it, with exactly one exception: the structural home var
 * (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`) survives a save that never MENTIONS
 * it. That var is the row's account identity (rule 2 of credential-home.ts),
 * not ordinary env, and no caller is in a position to re-send it: env VALUES
 * never cross IPC, so the Settings dialog prefills the key list with blanks
 * and sends back only the rows the user actually typed into. An ordinary
 * rename or recolor therefore arrives as `env: {}` - and overwriting the blob
 * with that dropped the home, so from the next spawn on the profile ran under
 * the SHARED canonical default while the UI still showed the isolated
 * directory the user had picked. `validateCredentialHome` could not catch it
 * either: it read the home out of the incoming map, found nothing, and
 * concluded the save claimed no directory at all.
 *
 * Pinning it here rather than in the renderer means every caller - Settings,
 * a remote client, a future importer - gets the invariant, and the one place
 * that decrypts is the one place that decides. Naming the key repoints the
 * home; naming it blank clears it; only omitting it means "leave my account
 * where it is".
 */
function envToStore(
  input: ProviderInstanceUpsertInput,
  existing: DbRow,
  agent: CredentialHomeAgent | null,
): Record<string, string> | null {
  if (input.env === null || input.env === undefined) return null
  if (!agent) return input.env
  const name = credentialHomeEnvName(agent)
  if (name in input.env) return input.env
  const stored = storedOverlayHome(existing, agent)
  if (stored.kind === 'absent') return input.env
  if (stored.kind === 'unreadable') {
    throw new Error(
      `upsertProviderInstance: the stored env overlay for ${existing.id} could not be read, `
      + `so its credential home (${name}) cannot be preserved - this save would silently move the `
      + `profile to the default account. Unlock the credential store and retry, or set ${name} explicitly.`,
    )
  }
  return { ...input.env, [name]: stored.value }
}

/** The home a row claims EXPLICITLY - its oauth_dir, else an overlay home.
 *  Null when it merely lands on the canonical default, which is not a claim
 *  and must not collide with anything. */
function explicitCredentialHome(r: DbRow): string | null {
  const dir = canonicalizeOauthPath(r.oauth_dir)
  const agent = credentialAgent(r.agent_type)
  if (dir) return agent ? effectiveCredentialHome(agent, dir) : dir
  return agent ? overlayCredentialHome(r, agent) : null
}

function rowToWire(r: DbRow): ProviderInstanceWire {
  const agent = credentialAgent(r.agent_type)
  const canonical = expandTilde(r.oauth_dir)
  let effectiveOauthDir: string | null = canonical || null
  let effectiveOauthDirSource: EffectiveOauthDirSource = canonical ? 'oauth_dir' : 'default'
  if (!canonical && agent) {
    // No oauth_dir: the overlay decides, and only the key list may be
    // consulted here - LIST runs at every boot and decrypting would hit the
    // OS keychain (a login prompt on unsigned builds).
    const presence = overlayHomeKeyPresence(r, agent)
    if (presence === 'absent') {
      effectiveOauthDir = canonicalCredentialHome(agent)
    } else if (presence === 'present' && !hasMagic(r.env_encrypted ?? Buffer.alloc(0), ENC_MAGIC)
      && !hasMagic(r.env_encrypted ?? Buffer.alloc(0), PASS_MAGIC)) {
      // Plaintext fallback blob - readable with no keychain at all.
      const overlay = parseEnv((r.env_encrypted as Buffer).toString('utf-8'))[credentialHomeEnvName(agent)]
      effectiveOauthDir = effectiveCredentialHome(agent, overlay)
      // A key that is PRESENT but BLANK names no directory: the spawn env
      // falls back to the canonical default and `applyEnvOverlay` skips the
      // empty value outright. Same truthiness guard as `overlayCredentialHome`
      // and `resolveEffectiveOauthDir`, because calling that 'env' branded the
      // shared home as an isolated legacy profile - dropping the isolation
      // warning from the one row that needs it most.
      effectiveOauthDirSource = canonicalizeOauthPath(overlay) ? 'env' : 'default'
    } else {
      effectiveOauthDir = null
      effectiveOauthDirSource = 'unresolved'
    }
  } else if (canonical && agent) {
    effectiveOauthDir = effectiveCredentialHome(agent, canonical)
  }
  return {
    id: r.id,
    agentType: r.agent_type as AgentType,
    displayName: r.display_name,
    accentColor: r.accent_color,
    authMode: r.auth_mode === 'oauth_dir' ? 'oauth_dir' : 'env',
    envKeys: envKeysNoDecrypt(r),
    oauthDir: r.oauth_dir,  // wire keeps the literal so the user sees what they typed
    effectiveOauthDir,
    effectiveOauthDirSource,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * The authoritative answer for a row LIST had to leave `unresolved`: decrypt
 * the overlay and resolve the home exactly as `resolveInstanceEnv` would.
 *
 * Kept out of LIST on purpose - this is the call that may hit the keychain,
 * so the IPC layer makes it only for the handful of rows that need it. Null
 * for an unknown id: better no answer than an invented directory.
 */
export function resolveEffectiveOauthDir(id: string): {
  effectiveOauthDir: string | null
  effectiveOauthDirSource: EffectiveOauthDirSource
} | null {
  const row = getDb().prepare(
    'SELECT * FROM provider_instances WHERE id = ?'
  ).get(id) as DbRow | undefined
  if (!row) return null
  const agent = credentialAgent(row.agent_type)
  const canonical = expandTilde(row.oauth_dir)
  if (!agent) {
    return { effectiveOauthDir: canonical || null, effectiveOauthDirSource: canonical ? 'oauth_dir' : 'default' }
  }
  if (canonical) {
    return { effectiveOauthDir: effectiveCredentialHome(agent, canonical), effectiveOauthDirSource: 'oauth_dir' }
  }
  const overlay = decryptEnv(row.env_encrypted)
  const fromOverlay = canonicalizeOauthPath(overlay[credentialHomeEnvName(agent)])
  return {
    effectiveOauthDir: resolvedCredentialHome(agent, null, overlay),
    effectiveOauthDirSource: fromOverlay ? 'env' : 'default',
  }
}

export function listProviderInstances(): ProviderInstanceWire[] {
  const rows = getDb().prepare(
    'SELECT * FROM provider_instances ORDER BY agent_type ASC, created_at ASC'
  ).all() as DbRow[]
  return rows.map(rowToWire)
}

/** Internal - returns the full decrypted row. Used by the registry at
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
   *  to leave the existing env untouched on update; pass `{}` to clear.
   *
   *  One exception on update: the structural credential home
   *  (`CODEX_HOME`/`CLAUDE_CONFIG_DIR`) is carried forward when this map
   *  OMITS it, because it is the row's account identity and no caller can
   *  re-send a value that never crossed IPC. Name the key to repoint it, name
   *  it blank to clear it - see `envToStore`. */
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

/** Every row, in one read. The table holds a handful of rows, so validation
 *  filters in JS rather than adding query shapes for each check. */
function allRows(): DbRow[] {
  return getDb().prepare(
    'SELECT * FROM provider_instances ORDER BY agent_type ASC, created_at ASC'
  ).all() as DbRow[]
}

/**
 * Guard the credential home before it is stored.
 *
 * The home IS the credential: two enabled rows resolving to one directory are
 * not two profiles, they are one account wearing two names - and the account
 * the user thinks they picked is not the one that runs. So the effective
 * (tilde-expanded, normalized, absolute) home has to be unique among the
 * enabled rows of the same agent kind, and each credential-bearing kind's
 * canonical default (`~/.codex`, `~/.claude`) is additionally reserved for its
 * default row, since that is where a plain `codex login` / `claude login`
 * writes and any other row claiming it would hijack it. The rule is identical
 * for both kinds and for either source (oauth_dir column or env-overlay
 * home) - see `explicitCredentialHome`.
 *
 * Two things this deliberately does NOT key on:
 *
 *  - `auth_mode`. A legacy env-mode profile carries its home in its env
 *    overlay (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`), and `resolveInstanceEnv`
 *    honors it. Validating only the oauth_dir column let such a row share a
 *    directory with an oauth_dir row - the exact collision this exists to
 *    stop. Both forms are compared through the same resolver.
 *  - Rows that merely LAND on the canonical default. That is not a claim on a
 *    directory, so it collides with nothing; only an explicit home does.
 *
 * The home it validates is the home the write will STORE, not the one the
 * caller happened to send: `envToStore` carries a legacy row's overlay home
 * forward across a save that omits it, so the guard has to see the same
 * value - otherwise a rename looks like a row that claims no directory at
 * all, and the uniqueness/reserved rules stop protecting a home that is
 * still very much in force.
 *
 * And an UNCHANGED, already-enabled row is exempt from the reserved/uniqueness
 * rules entirely: renaming or recoloring a legacy row that was already sitting
 * on `~/.codex` (or already duplicating another row) introduces no new
 * collision, and re-throwing on every save left the user with no way out of
 * the dialog. Moving a row onto such a directory, creating one there, or
 * enabling a disabled one still fails.
 */
function validateCredentialHome(
  input: ProviderInstanceUpsertInput,
  existing: DbRow | undefined,
  resolvedId: string,
  plannedEnv: Record<string, string> | null,
): void {
  const agent = credentialAgent(input.agentType)
  const authMode = input.authMode ?? (existing?.auth_mode === 'oauth_dir' ? 'oauth_dir' : 'env')
  const rawDir = input.oauthDir === undefined ? existing?.oauth_dir ?? null : input.oauthDir
  const enabled = input.enabled === undefined
    ? (existing ? existing.enabled === 1 : true)
    : input.enabled

  const dir = canonicalizeOauthPath(rawDir)
  if (authMode === 'oauth_dir') {
    if (!dir) {
      throw new Error('upsertProviderInstance: oauth_dir mode needs a non-empty directory path')
    }
    if (!isAbsolute(dir)) {
      throw new Error(`upsertProviderInstance: oauth_dir path must be absolute (got ${JSON.stringify(rawDir)})`)
    }
  }

  // The home this save will actually produce: the oauth_dir if there is one,
  // else the structural var in the overlay that will be stored.
  const home = dir
    ? (agent ? effectiveCredentialHome(agent, dir) : dir)
    : overlayHomeAfterSave(plannedEnv, existing, agent)
  if (!home || !enabled) return

  const previous = existing ? explicitCredentialHome(existing) : null
  const unchanged = existing !== undefined && existing.enabled === 1 && previous === home
  if (unchanged) return

  if (agent
    && home === canonicalCredentialHome(agent)
    && resolvedId !== defaultInstanceId(input.agentType)) {
    throw new Error(`upsertProviderInstance: ${home} is reserved for the default ${AGENT_LABEL[agent]} instance`)
  }

  const clash = allRows().find((r) =>
    r.id !== resolvedId
    && r.agent_type === input.agentType
    && r.enabled === 1
    && explicitCredentialHome(r) === home)
  if (clash) {
    throw new Error(`upsertProviderInstance: oauth_dir ${home} is already used by instance ${clash.id}`)
  }
}

/**
 * The overlay-declared home this save leaves behind, or null.
 *
 * Reads the env map the write will actually store (see `envToStore`), never
 * the raw input: a rename that omits the home var still stores it, so
 * validating the raw input made the guard reason about an empty overlay while
 * the row kept an isolated home - the same divergence that let the home be
 * destroyed in the first place. A null `plannedEnv` means "keep the stored
 * blob", so the existing row's overlay is what will still be in force.
 */
function overlayHomeAfterSave(
  plannedEnv: Record<string, string> | null,
  existing: DbRow | undefined,
  agent: CredentialHomeAgent | null,
): string | null {
  if (!agent) return null
  if (plannedEnv === null) {
    // Only the OVERLAY carries over - a save that clears oauth_dir no longer
    // claims that directory, so it must not be validated against it.
    return existing ? overlayCredentialHome(existing, agent) : null
  }
  const declared = plannedEnv[credentialHomeEnvName(agent)]
  return canonicalizeOauthPath(declared) ? effectiveCredentialHome(agent, declared) : null
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
  const resolvedId = existing?.id ?? input.id ?? deriveId(input.agentType, input.displayName)
  // Resolve the env to be stored BEFORE validating, so the guard sees the
  // same overlay the write will persist - including a credential home the
  // caller could not re-send (see `envToStore`).
  const plannedEnv = existing
    ? envToStore(input, existing, credentialAgent(input.agentType))
    : input.env ?? null
  validateCredentialHome(input, existing, resolvedId, plannedEnv)

  if (existing) {
    // Update path. A null `plannedEnv` (`env: null`/`undefined`) keeps the
    // existing encrypted blob untouched.
    const envUntouched = plannedEnv === null
    const newEnv = envUntouched ? existing.env_encrypted : encryptEnv(plannedEnv!)
    const newEnvKeys = envUntouched
      ? existing.env_keys
      : JSON.stringify(Object.keys(plannedEnv!).sort())
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
              env_encrypted = ?, env_keys = ?, oauth_dir = ?, config_json = ?,
              enabled = ?, updated_at = ?
        WHERE id = ?`
    ).run(newName, newAccent, newAuth, newEnv, newEnvKeys, newOauthDir, newConfig, newEnabled, now, existing.id)
    return rowToWire(db.prepare('SELECT * FROM provider_instances WHERE id = ?').get(existing.id) as DbRow)
  }

  // Insert path
  const id = resolvedId
  const env = plannedEnv ? encryptEnv(plannedEnv) : null
  const config = input.configJson === undefined || input.configJson === null
    ? null
    : JSON.stringify(input.configJson)
  db.prepare(
    `INSERT INTO provider_instances
       (id, agent_type, display_name, accent_color, auth_mode,
        env_encrypted, env_keys, oauth_dir, config_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.agentType, input.displayName,
    input.accentColor ?? null,
    input.authMode ?? 'env',
    env,
    plannedEnv ? JSON.stringify(Object.keys(plannedEnv).sort()) : null,
    input.oauthDir ?? null,
    config,
    input.enabled === false ? 0 : 1,
    now, now,
  )
  return rowToWire(db.prepare('SELECT * FROM provider_instances WHERE id = ?').get(id) as DbRow)
}

export function deleteProviderInstance(id: string): boolean {
  // Refuse to delete the default-seeded row of an agent kind that has
  // no other instances - at least one must always exist so the picker
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

/**
 * Resolve an instance for use at session start.
 *
 * An EXPLICITLY requested id that cannot be honored THROWS. Silently
 * substituting `<agentType>-default` for a missing, disabled or wrong-kind id
 * meant the user picked "Work" and got whichever account the default row holds
 * - the turn still runs, against the wrong credential, with the UI still
 * showing the profile they chose. Failing loudly is the only outcome that
 * cannot bill someone else's account.
 *
 * With NO id requested (null/undefined) the fallback chain is unchanged:
 * the default row, else any enabled instance of the kind, else null for an
 * agent kind with no instances at all.
 */
export function resolveProviderInstance(
  agentType: AgentType,
  instanceId: string | undefined | null,
): ProviderInstanceRow | null {
  if (instanceId) {
    const exact = getProviderInstanceFull(instanceId)
    if (!exact) {
      throw new Error(`Provider instance not found: ${instanceId}`)
    }
    if (exact.agentType !== agentType) {
      throw new Error(
        `Provider instance ${instanceId} is the wrong kind for ${agentType} (it is ${exact.agentType})`,
      )
    }
    if (!exact.enabled) {
      throw new Error(`Provider instance ${instanceId} is disabled`)
    }
    return exact
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

/**
 * Lenient sibling for callers that merely want to LOOK UP a profile's dir and
 * have a sane "no answer" branch - the RESOLVE_OAUTH_DIR helper the renderer
 * calls while the user is still editing profiles, where a stale id should
 * return null rather than reject the IPC call. Never use it on a path that
 * goes on to run a turn: that is exactly the silent-substitution this
 * module's strict resolver exists to prevent.
 */
export function tryResolveProviderInstance(
  agentType: AgentType,
  instanceId: string | undefined | null,
): ProviderInstanceRow | null {
  try {
    return resolveProviderInstance(agentType, instanceId)
  } catch (err) {
    log.warn(`instance lookup failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
