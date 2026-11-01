/**
 * Children on other machines: the pure rules both ends share.
 *
 * The desktop's hub client reaches another machine's backend with the server
 * token narrowed to the `hub` scope (`HUB_REMOTE_AUTH_SCOPES`), and reads
 * what that machine offers through `hub-remote:describe`.
 */
import type { DeviceScope } from './device-auth'
import { modelsForAgent } from './models'
import type { AgentProvider, AgentType } from './types'

/** What the hub client asks for in its auth frame. */
export const HUB_REMOTE_AUTH_SCOPES: readonly DeviceScope[] = ['hub']

/**
 * Whether an `authed` answer granted the hub client exactly `['hub']`. Any
 * other set is a failure: a backend that predates the `scopes` key drops it
 * and grants the token's full set, and the client must not hold that.
 */
export function isHubAuthGrant(granted: readonly string[] | undefined): boolean {
  return Array.isArray(granted) && granted.length === 1 && granted[0] === 'hub'
}

/** At most this many projects in one description. */
export const HUB_DESCRIBE_MAX_PROJECTS = 200

export interface HubMachineAccount {
  instanceId: string
  name: string
}

export interface HubMachineAgent {
  agent: AgentProvider
  accounts: HubMachineAccount[]
  models: string[]
}

export interface HubMachineProject {
  path: string
  /** Null when the folder is not a repository or HEAD is detached. */
  branch: string | null
  /** Fetch URLs of its git remotes, deduplicated, without credentials. */
  remoteUrls: string[]
}

export interface HubMachineRunSlots {
  instanceId: string
  running: number
  limit: number
}

/**
 * One machine as the hub sees it. It never holds the machine's host name,
 * cloud project, zone or user name: the desktop knows the machine by its own
 * id and display name.
 */
export interface HubMachineDescription {
  v: 1
  flagOn: boolean
  os: string
  arch: string
  backendVersion: string
  agents: HubMachineAgent[]
  projects: HubMachineProject[]
  /** Free space under the projects root (or the home folder); null when unread. */
  freeDiskBytes: number | null
  openChildren: number
  runSlots: HubMachineRunSlots[]
}

/** What the backend reads before it describes itself. */
export interface HubDescribeFacts {
  flagOn: boolean
  os: string
  arch: string
  backendVersion: string
  /** Agents whose program runs on this backend. */
  availableAgents: readonly AgentProvider[]
  instances: ReadonlyArray<{ id: string; agentType: AgentType; displayName: string; enabled: boolean }>
  /** The backend's home folder: project paths under it are sent as `~/...`. */
  homeDir: string
  projects: readonly HubMachineProject[]
  freeDiskBytes: number | null
  openChildren: number
  /** The account id of each child with a turn in flight. */
  runningSlotKeys: readonly string[]
  runningPerInstance: number
}

/**
 * The description from what the backend read. An agent is listed only when
 * its program runs here and it has an enabled account.
 */
export function buildHubMachineDescription(f: HubDescribeFacts): HubMachineDescription {
  const enabled = f.instances.filter((i) => i.enabled)
  const agents: HubMachineAgent[] = []
  const runSlots: HubMachineRunSlots[] = []
  for (const agent of f.availableAgents) {
    const accounts = enabled.filter((i) => i.agentType === agent)
    if (accounts.length === 0) continue
    agents.push({
      agent,
      accounts: accounts.map((i) => ({ instanceId: i.id, name: i.displayName })),
      models: modelsForAgent(agent).map((m) => m.id),
    })
    for (const i of accounts) {
      runSlots.push({
        instanceId: i.id,
        running: f.runningSlotKeys.filter((k) => k === i.id).length,
        limit: f.runningPerInstance,
      })
    }
  }
  return {
    v: 1,
    flagOn: f.flagOn,
    os: f.os,
    arch: f.arch,
    backendVersion: f.backendVersion,
    agents,
    projects: f.projects.slice(0, HUB_DESCRIBE_MAX_PROJECTS).flatMap((p) => {
      const path = pathFromHome(p.path, f.homeDir)
      if (path === null) return []
      const urls = p.remoteUrls.map(cleanRemoteUrl).filter((u): u is string => u !== null)
      return [{ path, branch: p.branch, remoteUrls: [...new Set(urls)] }]
    }),
    freeDiskBytes: f.freeDiskBytes,
    openChildren: f.openChildren,
    runSlots,
  }
}

/**
 * A project path as the hub sees it: `~/...` under the home folder, so the
 * user name stays on the machine. A path in another user's home is left out.
 */
function pathFromHome(path: string, home: string): string | null {
  const p = path.replace(/\\/g, '/')
  const root = home.replace(/\\/g, '/').replace(/\/+$/, '')
  if (p === root) return '~'
  if (p.startsWith(`${root}/`)) return `~${p.slice(root.length)}`
  if (/^(?:[A-Za-z]:)?\/(home|Users)\//i.test(p)) return null
  return path
}

/**
 * A git remote without its user part, which can be a token
 * (`https://token@host/...`) or a login name (`ssh://user@host/...`,
 * `user@host:repo`), and without a query or fragment, which can carry a token
 * too. A local path, a drive path or a `file://` remote is null: it names
 * folders on this machine, not a remote another machine can reach.
 */
export function cleanRemoteUrl(url: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)
  if (scheme) {
    if (scheme[1].toLowerCase() === 'file') return null
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1').replace(/[?#].*$/, '')
  }
  if (/^[A-Za-z]:[\\/]/.test(url)) return null
  const scp = /^(?:[^/@:\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(url)
  return scp ? `${scp[1]}:${scp[2]}` : null
}

/** The fetch URLs in `git remote -v` output, deduplicated, in order. */
export function parseGitRemoteFetchUrls(out: string): string[] {
  const urls: string[] = []
  for (const line of out.split('\n')) {
    const m = /^\S+\s+(\S+)\s+\(fetch\)\s*$/.exec(line)
    if (m && !urls.includes(m[1])) urls.push(m[1])
  }
  return urls
}

/** The capability a backend advertises when it answers `hub-remote:*`. */
export const HUB_REMOTE_CAPABILITY = 'hub_remote_child_v1'

/** The desktop's own entry in `list_machines`. */
export const LOCAL_MACHINE_ID = 'local'

export type HubMachineTransport = 'local' | 'ssh' | 'gcloud-iap'
export type HubMachineStatus = 'connected' | 'connecting' | 'offline' | 'error'

/**
 * One machine for `list_machines`. It holds the id and the name the user gave
 * the machine, never its host name, ssh alias, cloud project, zone or user.
 */
export interface HubMachineEntry {
  id: string
  name: string
  transport: HubMachineTransport
  status: HubMachineStatus
  /** The newest description; null before the first answer. */
  description: HubMachineDescription | null
  /** How old the description is; null for the desktop, which is read now. */
  ageMs: number | null
  /** Why the hub client does not use this machine, for example an older backend. */
  problem: string | null
}

/**
 * A description from another machine, or null when its shape is wrong. The
 * answer comes over the wire, so nothing in it is trusted.
 */
export function parseHubMachineDescription(value: unknown): HubMachineDescription | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Record<string, unknown>
  const isArray = (x: unknown): x is unknown[] => Array.isArray(x)
  if (d.v !== 1 || typeof d.flagOn !== 'boolean' || typeof d.os !== 'string' || typeof d.arch !== 'string') return null
  if (typeof d.backendVersion !== 'string' || typeof d.openChildren !== 'number') return null
  if (d.freeDiskBytes !== null && typeof d.freeDiskBytes !== 'number') return null
  if (!isArray(d.agents) || !isArray(d.projects) || !isArray(d.runSlots)) return null
  const agentsOk = d.agents.every((a) => {
    const x = a as HubMachineAgent | null
    return (
      !!x &&
      typeof x.agent === 'string' &&
      isArray(x.models) &&
      x.models.every((m) => typeof m === 'string') &&
      isArray(x.accounts) &&
      x.accounts.every((c) => !!c && typeof c.instanceId === 'string' && typeof c.name === 'string')
    )
  })
  const projectsOk = d.projects.every((p) => {
    const x = p as HubMachineProject | null
    return (
      !!x &&
      typeof x.path === 'string' &&
      (x.branch === null || typeof x.branch === 'string') &&
      isArray(x.remoteUrls) &&
      x.remoteUrls.every((u) => typeof u === 'string')
    )
  })
  const slotsOk = d.runSlots.every((s) => {
    const x = s as HubMachineRunSlots | null
    return !!x && typeof x.instanceId === 'string' && typeof x.running === 'number' && typeof x.limit === 'number'
  })
  return agentsOk && projectsOk && slotsOk ? (value as HubMachineDescription) : null
}

/**
 * One key for every form of a git remote, so `https://host/o/r.git`,
 * `ssh://git@host:22/o/r` and `git@host:o/r.git` match: host and path, lower
 * case, without user, port, query or a trailing `.git`. Null for a local path.
 */
export function remoteUrlKey(url: string): string | null {
  const clean = cleanRemoteUrl(url.trim())
  if (clean === null) return null
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)(\/.*)?$/i.exec(clean)
  const [host, path] = scheme
    ? [scheme[1].replace(/:\d*$/, ''), scheme[2] ?? '']
    : [clean.slice(0, clean.indexOf(':')), clean.slice(clean.indexOf(':') + 1)]
  const repo = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  if (!host || !repo) return null
  return `${host}/${repo}`.toLowerCase()
}

/**
 * The text `list_machines` answers: one block per machine, in the given order
 * (the desktop first). Only what the entries hold is written, so a host name
 * or a cloud project never reaches the agent.
 */
export function formatHubMachineList(entries: readonly HubMachineEntry[], callerRemoteUrls: readonly string[]): string {
  const keys = new Set(callerRemoteUrls.map(remoteUrlKey).filter((k): k is string => k !== null))
  const blocks = entries.map((e) => machineBlock(e, keys))
  return [`${entries.length} machine${entries.length === 1 ? '' : 's'}. Name a machine by its id.`, ...blocks].join(
    '\n\n',
  )
}

function machineBlock(e: HubMachineEntry, callerKeys: ReadonlySet<string>): string {
  const age = e.ageMs === null ? '' : e.description ? `, described ${formatAge(e.ageMs)} ago` : ', not described yet'
  const lines = [`${e.id}: ${e.name}`, `  transport ${e.transport}, ${e.status}${age}`]
  if (e.problem) lines.push(`  ${e.problem}`)
  const d = e.description
  if (!d) return lines.join('\n')
  if (!d.flagOn) lines.push('  does not take children: hub_remote_children is off there')
  lines.push(`  os ${d.os} ${d.arch}`)
  if (d.agents.length === 0) lines.push('  agents: none with a login')
  else {
    lines.push('  agents:')
    for (const a of d.agents) {
      const accounts = a.accounts.map((c) => `${c.instanceId} (${c.name})`).join(', ')
      lines.push(`    ${a.agent}: accounts ${accounts}; models ${a.models.join(', ') || 'none'}`)
    }
  }
  lines.push(`  projects with this chat's remote: ${matchingProjects(d.projects, callerKeys)}`)
  const disk = d.freeDiskBytes === null ? 'unknown' : formatGb(d.freeDiskBytes)
  lines.push(`  free disk ${disk}, open children ${d.openChildren}`)
  if (d.runSlots.length > 0) {
    const slots = d.runSlots.map((s) => `${s.instanceId} ${Math.max(0, s.limit - s.running)} of ${s.limit}`)
    lines.push(`  free run slots: ${slots.join(', ')}`)
  }
  return lines.join('\n')
}

function matchingProjects(projects: readonly HubMachineProject[], callerKeys: ReadonlySet<string>): string {
  if (callerKeys.size === 0) return "none (this chat's project has no git remote)"
  const hits = projects.filter((p) => p.remoteUrls.some((u) => callerKeys.has(remoteUrlKey(u) ?? '')))
  if (hits.length === 0) return 'none'
  return hits.map((p) => `${p.path} (${p.branch ?? 'no branch'})`).join(', ')
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} days`
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
