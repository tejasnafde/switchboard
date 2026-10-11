/**
 * A Codex `item/permissions/requestApproval` request, read into what the
 * approval card shows and what an approval grants. The two come from the same
 * parse, so an approval grants exactly the permissions the card listed and
 * nothing else. A request Switchboard cannot show in full (a field it does not
 * know, or more paths than the cap) is refused, never granted.
 *
 * The profile shape is Codex's `RequestPermissionProfile` (codex-cli 0.162.1,
 * `tests/fixtures/codex-app-server-schema.json`).
 */

/** At most this many paths and patterns in one request. */
export const CODEX_PERMISSION_PATH_CAP = 200
/** At most this many characters of listed permissions in one request. */
export const CODEX_PERMISSION_TEXT_CAP = 32 * 1024

/** One permission on the card, with every path it covers. */
export interface CodexPermissionSection {
  label: string
  items: string[]
}

/** What the approval card shows for a permissions request. */
export interface CodexPermissionView {
  reason?: string
  sections: CodexPermissionSection[]
}

export type CodexPermissionRead =
  | { ok: true; view: CodexPermissionView; detail: string; granted: Record<string, unknown> }
  | { ok: false; reason: string }

const ACCESS_LABEL: Record<string, string> = { read: 'Read access', write: 'Write access', deny: 'No access' }
const SPECIAL_LABEL: Record<string, string> = {
  root: 'the whole file system',
  minimal: 'the minimal system paths',
  project_roots: 'the project folders',
  tmpdir: 'the temporary folder',
  slash_tmp: '/tmp',
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const UNREADABLE = 'Codex asked for a permission Switchboard cannot show, so Switchboard denied it.'

class Unreadable extends Error {}

function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((k) => !keys.includes(k))) throw new Unreadable()
}

function strings(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Unreadable()
  return value as string[]
}

function specialPath(value: unknown): string {
  const special = record(value)
  if (!special || typeof special.kind !== 'string') throw new Unreadable()
  const subpath = typeof special.subpath === 'string' ? special.subpath : null
  if (special.subpath !== undefined && special.subpath !== null && subpath === null) throw new Unreadable()
  if (special.kind === 'unknown') {
    onlyKeys(special, ['kind', 'path', 'subpath'])
    if (typeof special.path !== 'string') throw new Unreadable()
    return subpath ? `${special.path} (${subpath})` : special.path
  }
  const label = Object.hasOwn(SPECIAL_LABEL, special.kind) ? SPECIAL_LABEL[special.kind] : undefined
  if (!label) throw new Unreadable()
  onlyKeys(special, special.kind === 'project_roots' ? ['kind', 'subpath'] : ['kind'])
  return subpath ? `${label}: ${subpath}` : label
}

function entryPath(value: unknown): string {
  const path = record(value)
  if (!path) throw new Unreadable()
  if (path.type === 'path' && typeof path.path === 'string') {
    onlyKeys(path, ['type', 'path'])
    return path.path
  }
  if (path.type === 'glob_pattern' && typeof path.pattern === 'string') {
    onlyKeys(path, ['type', 'pattern'])
    return `${path.pattern} (pattern)`
  }
  if (path.type === 'special') {
    onlyKeys(path, ['type', 'value'])
    return specialPath(path.value)
  }
  throw new Unreadable()
}

interface ReadProfile {
  sections: CodexPermissionSection[]
  granted: Record<string, unknown>
  paths: number
}

function readProfile(permissions: unknown): ReadProfile {
  const profile = record(permissions)
  if (!profile) throw new Unreadable()
  onlyKeys(profile, ['fileSystem', 'network'])
  const sections: CodexPermissionSection[] = []
  const granted: Record<string, unknown> = {}
  let paths = 0

  const fs = record(profile.fileSystem)
  if (profile.fileSystem !== undefined && profile.fileSystem !== null && !fs) throw new Unreadable()
  if (fs) {
    onlyKeys(fs, ['entries', 'globScanMaxDepth', 'read', 'write'])
    const grantedFs: Record<string, unknown> = {}
    const write = strings(fs.write)
    const read = strings(fs.read)
    if (write) {
      sections.push({ label: 'Write access', items: write })
      grantedFs.write = write
      paths += write.length
    }
    if (read) {
      sections.push({ label: 'Read access', items: read })
      grantedFs.read = read
      paths += read.length
    }
    if (fs.entries !== undefined && fs.entries !== null) {
      if (!Array.isArray(fs.entries)) throw new Unreadable()
      const byAccess = new Map<string, string[]>()
      const entries = fs.entries.map((raw) => {
        const entry = record(raw)
        if (!entry || typeof entry.access !== 'string' || !Object.hasOwn(ACCESS_LABEL, entry.access))
          throw new Unreadable()
        onlyKeys(entry, ['access', 'path'])
        const shown = entryPath(entry.path)
        byAccess.set(entry.access, [...(byAccess.get(entry.access) ?? []), shown])
        return entry
      })
      for (const access of ['write', 'read', 'deny']) {
        const items = byAccess.get(access)
        if (items) sections.push({ label: `${ACCESS_LABEL[access]} (entries)`, items })
      }
      grantedFs.entries = entries
      paths += entries.length
    }
    if (fs.globScanMaxDepth !== undefined && fs.globScanMaxDepth !== null) {
      if (typeof fs.globScanMaxDepth !== 'number') throw new Unreadable()
      sections.push({ label: 'Pattern search depth', items: [String(fs.globScanMaxDepth)] })
      grantedFs.globScanMaxDepth = fs.globScanMaxDepth
    }
    granted.fileSystem = grantedFs
  }

  const network = record(profile.network)
  if (profile.network !== undefined && profile.network !== null && !network) throw new Unreadable()
  if (network) {
    onlyKeys(network, ['enabled'])
    if (network.enabled !== undefined && network.enabled !== null && typeof network.enabled !== 'boolean') {
      throw new Unreadable()
    }
    if (typeof network.enabled === 'boolean') {
      sections.push({ label: 'Network access', items: [network.enabled ? 'On' : 'Off'] })
      granted.network = { enabled: network.enabled }
    } else {
      granted.network = {}
    }
  }
  return { sections, granted, paths }
}

/** The plain-text form of the card, for clients that render only `detail`. Lists every path. */
export function codexPermissionDetail(view: CodexPermissionView): string {
  const lines = ['Codex asks for these permissions for this turn.']
  if (view.reason) lines.push(`Reason: ${view.reason}`)
  if (view.sections.length === 0) lines.push('No permissions listed.')
  for (const section of view.sections) {
    lines.push('', `${section.label} (${section.items.length}):`, ...section.items.map((item) => `  ${item}`))
  }
  return lines.join('\n')
}

/** Reads the `params` of an `item/permissions/requestApproval` request. */
export function readCodexPermissionRequest(params: unknown): CodexPermissionRead {
  const request = record(params)
  let read: ReadProfile
  try {
    read = readProfile(request?.permissions)
  } catch (err) {
    if (err instanceof Unreadable) return { ok: false, reason: UNREADABLE }
    throw err
  }
  const paths = read.paths
  if (paths > CODEX_PERMISSION_PATH_CAP) {
    return {
      ok: false,
      reason: `Codex asked for access to ${paths} paths. Switchboard shows at most ${CODEX_PERMISSION_PATH_CAP} on an approval card, so it denied the request.`,
    }
  }
  const reason = typeof request?.reason === 'string' && request.reason.trim() ? request.reason : undefined
  const view: CodexPermissionView = { ...(reason ? { reason } : {}), sections: read.sections }
  const detail = codexPermissionDetail(view)
  if (detail.length > CODEX_PERMISSION_TEXT_CAP) {
    return {
      ok: false,
      reason: `Codex asked for more permissions than Switchboard can show on an approval card (over ${CODEX_PERMISSION_TEXT_CAP / 1024} KiB), so it denied the request.`,
    }
  }
  return { ok: true, view, detail, granted: read.granted }
}
