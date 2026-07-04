/**
 * Remote-machine helpers for the provider registry.
 *
 * Two concerns live here, both pure enough to unit-test:
 *   1. Forwarding an oauth_dir Claude instance's credentials to a remote VM
 *      (which resolver + file-selection helpers, plus the fs reader used by
 *      the local-only IPC handler).
 *   2. Gating Codex / OpenCode off remote machines (only Claude Code runs on
 *      remote VMs today).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { userInfo } from 'node:os'
import { resolveProviderInstance } from '../db/providerInstances'
import { createMainLogger as createLogger } from '../logger'
import type { AgentType } from '@shared/types'
import type { ProviderKind } from './types'

const log = createLogger('provider:remote-gate')
const execFileP = promisify(execFile)

/**
 * On macOS the Claude CLI keeps its OAuth token in the login Keychain
 * ("Claude Code-credentials"), not a `.credentials.json` file - so a Mac has no
 * file to forward. Read that blob (it's the exact JSON a linux VM expects at
 * CLAUDE_CONFIG_DIR/.credentials.json) so remote Claude can authenticate.
 * Never logs the token. Returns null off-macOS or when the item is absent.
 */
async function readMacKeychainCreds(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-a', userInfo().username, '-w',
    ])
    const blob = stdout.trim()
    return blob.length > 0 ? blob : null
  } catch (err) {
    log.warn(`oauth forward: keychain read failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Cred files forwarded to a remote for an `oauth_dir` Claude instance.
 * `.credentials.json` is required (the OAuth token lives here); `settings.json`
 * is optional and only forwarded when present.
 */
export const FORWARDABLE_OAUTH_FILES = ['.credentials.json', 'settings.json'] as const

/** The one file that must be present for forwarding to be worthwhile. */
export const REQUIRED_OAUTH_FILE = '.credentials.json'

/**
 * Sanitize a threadId into a safe single filesystem path segment so a crafted
 * id can't escape the per-session oauth dir. Anything outside [A-Za-z0-9._-]
 * becomes an underscore.
 */
export function sanitizeThreadId(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Pure: given the raw file->contents map we managed to read from an oauth dir,
 * return the subset actually worth forwarding. Empty map if the required file
 * is missing/blank; otherwise only the allowed, non-empty entries.
 */
export function pickForwardableCreds(available: Record<string, string>): Record<string, string> {
  const required = available[REQUIRED_OAUTH_FILE]
  if (!required || required.length === 0) return {}
  const out: Record<string, string> = {}
  for (const name of FORWARDABLE_OAUTH_FILES) {
    const content = available[name]
    if (content && content.length > 0) out[name] = content
  }
  return out
}

/**
 * Human label for a provider that isn't available on remote machines yet, or
 * null when it is (Claude). Drives both the hard-deny at session start and the
 * IS_AVAILABLE gray-out.
 */
export function remoteBlockedProviderLabel(provider: ProviderKind): string | null {
  if (provider === 'codex') return 'Codex'
  if (provider === 'opencode') return 'OpenCode'
  return null
}

/**
 * Read the forwardable oauth cred files off the local desktop for an instance.
 * Local-only (invoked from the desktop IPC handler); never runs on the remote.
 * Returns a filename->contents map, or `{}` when the instance has no oauth_dir
 * or the required file can't be read. Never logs credential contents.
 */
export async function readForwardableOauthCreds(
  agentType: AgentType,
  instanceId: string | undefined,
): Promise<Record<string, string>> {
  const instance = resolveProviderInstance(agentType, instanceId)
  const dir = instance?.oauthDir
  if (!dir) return {}
  const available: Record<string, string> = {}
  for (const name of FORWARDABLE_OAUTH_FILES) {
    try {
      available[name] = await readFile(join(dir, name), 'utf-8')
    } catch (err) {
      if (name !== REQUIRED_OAUTH_FILE) log.debug(`oauth forward: optional file ${name} absent in ${dir}`)
    }
  }
  // macOS keeps the token in the Keychain, not a file - fall back to it so a Mac
  // desktop can still authenticate a remote (linux) Claude session.
  if (!available[REQUIRED_OAUTH_FILE]) {
    const kc = await readMacKeychainCreds()
    if (kc) available[REQUIRED_OAUTH_FILE] = kc
    else log.warn(`oauth forward: no ${REQUIRED_OAUTH_FILE} in ${dir} and no Keychain creds - remote Claude will be unauthenticated`)
  }
  return pickForwardableCreds(available)
}
