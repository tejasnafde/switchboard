/**
 * Per-device sessions for paired clients.
 *
 * Replaces one shared token that never expired, carried no scopes, could not be
 * revoked per device, and travelled in the URL query string. The QR now carries
 * a one-time pairing code, redeemed once for a session of the device's own, and
 * credentials travel in an `auth` frame.
 *
 * Be precise about what the scopes buy: a phone session cannot spawn a PTY or
 * administer pairings. It CAN do everything the chat surface does, and that
 * surface runs an agent. This is a reduction in blast radius, not a sandbox.
 */
import { KEYBOARD_OVERRIDES_SETTING } from './shortcuts'
import { HtmlLiveChannels, ProviderChannels, ProviderInstanceChannels, PullRequestWriteChannels } from './ipc-channels'
import { governedSettingKey } from './project-settings'
import { ACP_COMMAND_AGENT } from './acp-agents'
import type { DeviceIdentity, DevicePlatform } from './device-identity'

/** `terminal` is separate because a PTY is arbitrary code execution and nothing
 *  on the phone needs it. */
export type DeviceScope = 'chat' | 'terminal' | 'admin'

export const PHONE_SCOPES: readonly DeviceScope[] = ['chat']
export const FULL_SCOPES: readonly DeviceScope[] = ['chat', 'terminal', 'admin']

/**
 * Channel prefixes a scope is REQUIRED for. Anything unlisted is open to any
 * authenticated session.
 *
 * Deliberately not deny-by-default: that needs a hand-maintained list of every
 * channel, and missing one breaks a feature silently for paired devices only.
 */
const SCOPE_REQUIRED_PREFIXES: Record<DeviceScope, readonly string[]> = {
  // A clone runs git with a caller's URL; ignored-file reads and writes carry secrets.
  terminal: ['terminal:', 'project-clone:'],
  // Without this, a paired device could mint itself another session and revoke
  // every other device. Revocation must be out of reach of a revocable credential.
  // Source control accounts hold a host token. Status is gated too: it names
  // the account, and nothing on the phone configures one.
  admin: ['mobile-pairing:', 'source-control:'],
  // `chat` gates nothing on its own. It is the baseline every session has.
  chat: [],
}

const SCOPE_REQUIRED_CHANNELS: Partial<Record<DeviceScope, readonly string[]>> = {
  terminal: ['app:save-launch-config', ProviderInstanceChannels.TEST_DRAFT],
  // Removing a worktree can delete uncommitted work once a confirm is passed
  // along, and unprotecting one reopens it to cleanup. Nothing on the phone
  // does either.
  // Pull request writes post, approve and merge as the user on GitHub or
  // Bitbucket. The phone has no Reviews screen yet; reply and resolve may
  // open to it in a later release. The reads stay open.
  admin: [
    'worktree-manager:remove',
    'worktree-manager:set-protection',
    ...Object.values(PullRequestWriteChannels),
    // A session link lets two agents message each other past the hop limit,
    // without a card in auto mode. Creating or extending one is consent a
    // phone credential must not be able to grant, like approving a host
    // write; unlinking only takes power away, so it stays open.
    ProviderChannels.LINK_PEER,
    ProviderChannels.EXTEND_PEER_LINK,
    // Spends a banked Codex reset on a paid account, and cannot be undone.
    // The phone has no confirm for it; the usage read stays open.
    ProviderInstanceChannels.CONSUME_RESET,
    // The still image of a live page is what every phone shows for it. Only a
    // desktop renders one; phones read it (LOAD) and ask a desktop to open it.
    HtmlLiveChannels.UPDATE,
  ],
}

/**
 * Settings keys a chat-scoped device must not WRITE.
 *
 * `settings:set` is ungated for ordinary client preferences, but the table
 * also holds the mode a session starts in when the client did not
 * say (the phone routinely does not) and the OAuth client consent runs against.
 * Writable, those let a stolen phone credential grant itself full access.
 * Reads stay open for these: the phone seeds its picker from the mode. The
 * credential rows are in `ADMIN_ONLY_SETTING_FAMILIES`, gated for reads too.
 * The desktop's keyboard shortcuts are not a phone's to change either: the
 * phone has no Keyboard page, and a rebind moves keys under the user's hands.
 */
const ADMIN_ONLY_SETTING_KEYS: readonly string[] = [
  'chat.defaultRuntimeMode',
  'google.clientId',
  KEYBOARD_OVERRIDES_SETTING,
]

/**
 * Settings rows a chat-scoped device must neither READ nor WRITE, because they
 * hold device credentials or grant access. Writable, `deviceSessions` lets a
 * phone mint itself a session with every scope; readable, `devicePairingCode`
 * lets it pair another device. A name ending in `.` covers the whole family,
 * so a new `mobilePairing.*` or `opencode.env.*` key is protected on arrival.
 * The owners read and write these rows directly, never through `settings:*`.
 */
export const ADMIN_ONLY_SETTING_FAMILIES: readonly string[] = [
  'deviceSessions', // device-sessions.ts: token hashes, scopes, install ids, addresses
  'devicePairingCode', // device-sessions.ts: the live one-time pairing code
  'mobilePairing.', // mobile-server.ts: the endpoint switch, port and legacy shared token
  'pushTokens', // push/registry.ts: every paired device's push token
  'opencode.env.', // opencode/env.ts: provider API keys injected into OpenCode
  'google.clientSecret',
]

function inProtectedFamily(key: string): boolean {
  return ADMIN_ONLY_SETTING_FAMILIES.some((family) => (family.endsWith('.') ? key.startsWith(family) : key === family))
}

function adminOnly(scopes: readonly DeviceScope[], key: unknown, keys: readonly string[]): boolean {
  if (typeof key !== 'string') return true // shape errors belong to the handler
  const governed = governedSettingKey(key)
  if (!keys.includes(governed) && !inProtectedFamily(governed)) return true
  return scopes.includes('admin')
}

/** Arg-level, because the channel is legitimately open. Enforced beside the
 *  channel check so no other route reaches the row. A project override is
 *  gated as the setting it overrides: one project's default mode grants as
 *  much as the machine's. */
export function isSettingWriteAllowed(scopes: readonly DeviceScope[], key: unknown): boolean {
  return adminOnly(scopes, key, ADMIN_ONLY_SETTING_KEYS)
}

/** Reads of the credential families only; the other admin-only keys stay readable. */
export function isSettingReadAllowed(scopes: readonly DeviceScope[], key: unknown): boolean {
  return adminOnly(scopes, key, [])
}

/**
 * An account save that sets a launch config or makes a local command account
 * names a program the backend will run, which is what the terminal scope
 * guards. Ordinary account edits stay open.
 */
export function isAccountWriteAllowed(scopes: readonly DeviceScope[], input: unknown): boolean {
  if (!input || typeof input !== 'object') return true // shape errors belong to the handler
  const { agentType, configJson } = input as { agentType?: unknown; configJson?: unknown }
  if (agentType !== ACP_COMMAND_AGENT && configJson === undefined) return true
  return scopes.includes('terminal')
}

/** The frame-level form both hosts enforce: removing a protected key is a write too,
 *  and reading a credential family is gated like writing it. */
export function isSettingsFrameAllowed(scopes: readonly DeviceScope[], channel: string, args: unknown): boolean {
  const list = Array.isArray(args) ? args : []
  if (channel === ProviderInstanceChannels.UPSERT) return isAccountWriteAllowed(scopes, list[0])
  if (channel === 'settings:set' || channel === 'settings:remove') return isSettingWriteAllowed(scopes, list[0])
  if (channel === 'settings:get') return isSettingReadAllowed(scopes, list[0])
  // (projectPath, settingKey, value?)
  if (channel === 'settings:project-override-set' || channel === 'settings:project-override-remove') {
    return isSettingWriteAllowed(scopes, list[1])
  }
  return true
}

/** Whether a session holding `scopes` may call `channel`. */
export function isChannelAllowed(scopes: readonly DeviceScope[], channel: string): boolean {
  for (const [scope, prefixes] of Object.entries(SCOPE_REQUIRED_PREFIXES) as Array<[DeviceScope, readonly string[]]>) {
    if (prefixes.some((prefix) => channel.startsWith(prefix)) && !scopes.includes(scope)) return false
  }
  for (const [scope, channels] of Object.entries(SCOPE_REQUIRED_CHANNELS) as Array<[DeviceScope, readonly string[]]>) {
    if (channels.includes(channel) && !scopes.includes(scope)) return false
  }
  return true
}

function normalizedPath(path: string): string {
  const absolute = path.startsWith('/')
  const prefix = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(0, 2).toLowerCase() : absolute ? '/' : ''
  const segments: string[] = []
  for (const segment of path
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `${prefix}${prefix && prefix !== '/' ? '/' : ''}${segments.join('/')}`.toLowerCase()
}

/** Protect command-bearing repository configuration from chat-only direct file APIs. */
export function isFileMutationAllowed(
  scopes: readonly DeviceScope[],
  repositoryPath: unknown,
  subPath: unknown,
): boolean {
  if (scopes.includes('terminal')) return true
  if (typeof repositoryPath !== 'string' || typeof subPath !== 'string') return true
  const root = normalizedPath(repositoryPath).replace(/\/$/, '')
  const candidate =
    subPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(subPath)
      ? normalizedPath(subPath)
      : normalizedPath(`${root}/${subPath}`)
  return candidate !== `${root}/.switchboard/launch-config.yaml` && candidate !== `${root}/.switchboard/workspace.yaml`
}

export interface DeviceSession {
  /** Stable id for this device's session; what a revoke targets. */
  id: string
  /** sha256 of the session token. The token itself is never stored. */
  tokenHash: string
  /** Free text so a user with two phones can tell them apart. */
  label: string
  scopes: DeviceScope[]
  createdAt: number
  /** Set on every auth and refreshed at most once a minute while connected. */
  lastSeenAt: number
  revokedAt?: number
  /** Absent for a session paired by a phone that predates device_identity_v1. */
  identity?: DeviceIdentity
  /** Remote address of the latest authenticated connection. */
  lastAddress?: string
  /** Set on the desktop; overrides the name the phone reports. */
  customName?: string
}

/** Same bound as the reported identity fields. */
export const DEVICE_NAME_MAX = 128

/** What the desktop calls a device: the user's name, then the phone's own,
 *  then the pairing label. */
export function deviceDisplayName(view: Pick<DeviceSessionView, 'customName' | 'name' | 'label'>): string {
  return view.customName || view.name || view.label
}

export function isRevoked(session: DeviceSession): boolean {
  return session.revokedAt !== undefined
}

/** What the UI may see. The hash is not a secret, but showing it invites
 *  treating it as a user-meaningful identifier. */
export interface DeviceSessionView {
  id: string
  label: string
  scopes: DeviceScope[]
  createdAt: number
  lastSeenAt: number
  revoked: boolean
  /** Optional: absent for older phones and older backends. */
  installId?: string
  name?: string
  manufacturer?: string
  model?: string
  platform?: DevicePlatform
  osVersion?: string
  appVersion?: string
  lastAddress?: string
  customName?: string
  /** In memory only: an authenticated socket for this session is open now. */
  online?: boolean
}

export function toView(session: DeviceSession, online = false): DeviceSessionView {
  return {
    ...session.identity,
    id: session.id,
    label: session.label,
    scopes: session.scopes,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    revoked: isRevoked(session),
    ...(session.lastAddress ? { lastAddress: session.lastAddress } : {}),
    ...(typeof session.customName === 'string' && session.customName ? { customName: session.customName } : {}),
    online,
  }
}

/** Short because the flow is "look at a screen, scan it now". A code valid for
 *  hours is a second long-lived credential, which is what this removes. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000

export interface PairingCode {
  code: string
  expiresAt: number
  /** Consumed on first use, so a shoulder-surfed QR is worthless once the
   *  intended device has redeemed it. */
  usedAt?: number
}

export function isPairingCodeUsable(code: PairingCode | null, nowMs: number): boolean {
  return code !== null && code.usedAt === undefined && code.expiresAt > nowMs
}
