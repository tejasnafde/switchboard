/**
 * Children on other machines: the pure rules both ends share.
 *
 * The desktop's hub client reaches another machine's backend with the server
 * token narrowed to the `hub` scope (`HUB_REMOTE_AUTH_SCOPES`), and reads
 * what that machine offers through `hub-remote:describe`.
 */
import type { DeviceScope } from './device-auth'
import { modelsForAgent } from './models'
import { defaultInstanceId, type AgentProvider, type AgentType } from './types'

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
  projects: readonly HubMachineProject[]
  freeDiskBytes: number | null
  openChildren: number
  /** The run-slot key of each child with a turn in flight: an instance id, or the agent for its default account. */
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
      const isDefault = i.id === defaultInstanceId(agent)
      runSlots.push({
        instanceId: i.id,
        running: f.runningSlotKeys.filter((k) => k === i.id || (isDefault && k === agent)).length,
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
    projects: f.projects.slice(0, HUB_DESCRIBE_MAX_PROJECTS).map((p) => ({
      path: p.path,
      branch: p.branch,
      remoteUrls: [...new Set(p.remoteUrls.map(withoutCredentials))],
    })),
    freeDiskBytes: f.freeDiskBytes,
    openChildren: f.openChildren,
    runSlots,
  }
}

/** An http(s) URL loses its user part, which can be a token (`https://token@host/...`). */
function withoutCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]*@/i, '$1')
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
