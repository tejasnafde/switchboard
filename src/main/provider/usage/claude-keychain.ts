/**
 * Reads the Claude Code OAuth credential for a provider instance, from a
 * `<configDir>/.credentials.json` file (Linux, headless remote backends) or
 * the macOS login keychain.
 *
 * The keychain service name is derived from CLAUDE_CONFIG_DIR, which is what
 * makes lookup per-instance: unset gives `Claude Code-credentials`, set gives
 * `Claude Code-credentials-<sha256(dir).hex[0..8]>`.
 *
 * SECURITY: `security find-generic-password -w` prints the credential on
 * stdout, so no code path here may put child stdout into a returned message
 * or a log line. That is also why this does not reuse `runProbe` from
 * `ipc/providerInstances.ts`, whose callers surface stdout to the UI.
 */

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { homedir, userInfo } from 'os'
import { join, normalize, sep } from 'path'
import { createMainLogger } from '../../logger'

const log = createMainLogger('provider:usage-keychain')

const SERVICE_BASE = 'Claude Code-credentials'
const MAX_CANDIDATES = 8
const KEYCHAIN_TIMEOUT_MS = 2000
/**
 * Ceiling for the whole candidate sweep. A missing entry fails in
 * milliseconds, but a keychain ACL prompt blocks `security` until dismissed,
 * and candidates x accounts is up to 24 spawns - without this the button
 * could hang for minutes.
 */
const KEYCHAIN_BUDGET_MS = 8000

export interface StoredClaudeCredential {
  accessToken: string
  /** Epoch ms. null when the payload omits it. */
  expiresAtMs: number | null
  subscriptionType: string | null
  scopes: string[]
}

export type CredentialReadResult =
  | { kind: 'found'; credential: StoredClaudeCredential; source: string }
  | { kind: 'missing'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string }

function sha8(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function stripTrailingSep(value: string): string {
  if (value.length > 1 && (value.endsWith(sep) || value.endsWith('/'))) {
    return value.replace(/[/\\]+$/, '')
  }
  return value
}

/**
 * Ordered, deduped keychain service names to try for a given config dir.
 *
 * More than one is needed because the hash is taken over the raw string, so
 * a trailing separator, a `~` that was never expanded, an unnormalised `//`,
 * or NFD-composed non-ASCII all produce a different digest for what is
 * actually the same directory.
 *
 * Pure and home-dir-injectable so the golden hashes can be asserted in tests.
 */
export function claudeKeychainServiceCandidates(
  configDir: string | null | undefined,
  homeDir?: string,
): string[] {
  const raw = (configDir ?? '').trim()
  // An unset CLAUDE_CONFIG_DIR is the only case that uses the bare name.
  // "set to the default dir" still hashes, so this must not fall through.
  if (!raw) return [SERVICE_BASE]

  const seeds: string[] = []
  const pushSeed = (value: string) => {
    if (value && !seeds.includes(value)) seeds.push(value)
  }

  const expanded = raw.startsWith('~/') && homeDir ? join(homeDir, raw.slice(2)) : null

  for (const base of [raw, expanded].filter((v): v is string => Boolean(v))) {
    pushSeed(base)
    pushSeed(stripTrailingSep(base))
    pushSeed(normalize(base))
    pushSeed(stripTrailingSep(normalize(base)))
  }

  const names: string[] = []
  for (const seed of seeds) {
    for (const form of [seed.normalize('NFC'), seed.normalize('NFD')]) {
      const name = `${SERVICE_BASE}-${sha8(form)}`
      if (!names.includes(name)) names.push(name)
      if (names.length >= MAX_CANDIDATES) return names
    }
  }
  return names
}

/** Accounts to try, in order. Undefined means "omit -a and take any match". */
export function keychainAccountCandidates(envUser?: string): Array<string | undefined> {
  const out: Array<string | undefined> = []
  if (envUser && envUser.trim()) out.push(envUser.trim())
  try {
    const name = userInfo().username
    if (name && !out.includes(name)) out.push(name)
  } catch {
    log.debug('userInfo() unavailable when building keychain account candidates')
  }
  // Last resort: no -a at all. On a single-account machine the service name
  // alone is unambiguous, and this covers a USER that diverges from the one
  // the CLI wrote under (sudo -E, launchd, a hand-exported USER).
  out.push(undefined)
  return out
}

/**
 * Parse the stored credential blob. Shape is `{ claudeAiOauth: { ... } }`
 * for both the keychain payload and the on-disk file.
 */
export function parseStoredClaudeCredential(raw: string): StoredClaudeCredential | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Length only - the blob is the credential.
    log.warn(`stored credential was not JSON (${raw.length} bytes)`)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const outer = parsed as Record<string, unknown>
  const oauth = outer.claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null) return null
  const record = oauth as Record<string, unknown>
  const accessToken = record.accessToken
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null
  return {
    accessToken,
    expiresAtMs: typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
      ? record.expiresAt
      : null,
    subscriptionType: typeof record.subscriptionType === 'string' ? record.subscriptionType : null,
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((s): s is string => typeof s === 'string')
      : [],
  }
}

function readCredentialFile(configDir: string): StoredClaudeCredential | null {
  try {
    const contents = readFileSync(join(configDir, '.credentials.json'), 'utf-8')
    if (!contents.trim()) return null
    return parseStoredClaudeCredential(contents)
  } catch (err) {
    // ENOENT is the common, expected case on macOS. EACCES/EPERM is the TCC
    // failure mode documented in CLAUDE.md and must not pass silently.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') log.warn(`could not read credentials file in ${configDir}: ${code ?? 'unknown error'}`)
    return null
  }
}

/**
 * Run `security find-generic-password -w`. Resolves the raw payload or null.
 * Deliberately returns no stdout on any failure path.
 */
type SecurityResult =
  | { kind: 'ok'; payload: string }
  | { kind: 'absent' }
  /** Killed by the timeout, which is what a blocking ACL prompt looks like. */
  | { kind: 'blocked' }

function runSecurity(service: string, account: string | undefined): Promise<SecurityResult> {
  const args = ['find-generic-password', '-s', service]
  if (account) args.push('-a', account)
  args.push('-w')
  return new Promise((resolve) => {
    execFile('/usr/bin/security', args, { timeout: KEYCHAIN_TIMEOUT_MS, encoding: 'utf-8' }, (err, stdout) => {
      if (err) {
        // Never surface stdout or stderr: stdout is the credential itself.
        // Only the error's shape is safe to inspect.
        const e = err as NodeJS.ErrnoException & { killed?: boolean }
        resolve(e.killed ? { kind: 'blocked' } : { kind: 'absent' })
        return
      }
      const trimmed = stdout.trim()
      resolve(trimmed.length > 0 ? { kind: 'ok', payload: trimmed } : { kind: 'absent' })
    })
  })
}

/**
 * Resolve the OAuth credential for an instance.
 *
 * @param configDir the EFFECTIVE CLAUDE_CONFIG_DIR from the resolved spawn
 *   env, not `instance.oauthDir` - an env overlay can set the variable
 *   directly (without tilde expansion), and the launching shell can leak one in.
 */
export async function readClaudeCredential(configDir: string | null): Promise<CredentialReadResult> {
  // With no explicit dir the CLI uses ~/.claude, and that is where a Linux or
  // headless-remote install writes its credentials file. Skipping this made
  // Claude usage permanently unavailable on every non-macOS backend.
  const fileDir = configDir ?? join(homedir(), '.claude')
  const fromFile = readCredentialFile(fileDir)
  if (fromFile) return { kind: 'found', credential: fromFile, source: 'credentials file' }

  if (process.platform !== 'darwin') {
    return {
      kind: 'unsupported',
      message: `No credentials file at ${join(fileDir, '.credentials.json')}, and the macOS keychain is not available on this backend.`,
    }
  }

  // Expansion needs the real home dir: an env overlay can set a literal
  // "~/..." that never went through expandTilde.
  const services = claudeKeychainServiceCandidates(configDir, homedir())
  const accounts = keychainAccountCandidates(process.env.USER)
  const deadline = Date.now() + KEYCHAIN_BUDGET_MS

  let blocked = false
  for (const service of services) {
    for (const account of accounts) {
      if (Date.now() >= deadline) blocked = true
      if (blocked) break
      const out = await runSecurity(service, account)
      if (out.kind === 'blocked') {
        log.warn(`keychain lookup for ${service} was killed by the timeout`)
        blocked = true
        break
      }
      if (out.kind === 'absent') continue
      const credential = parseStoredClaudeCredential(out.payload)
      if (credential) {
        log.debug(`credential resolved from keychain service ${service}`)
        return { kind: 'found', credential, source: `keychain ${service}` }
      }
      log.warn(`keychain entry ${service} did not contain a claudeAiOauth payload`)
    }
    if (blocked) break
  }

  if (blocked) {
    return {
      kind: 'error',
      message: 'Timed out reading the keychain. Access may be waiting on a permission prompt.',
    }
  }

  log.info(`no keychain match for ${services.length} candidate service name(s)`)
  return {
    kind: 'missing',
    message: `No stored Claude login for this instance (looked for keychain entry ${services[0] ?? SERVICE_BASE}).`,
  }
}
