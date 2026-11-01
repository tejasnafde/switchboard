/**
 * Children on other machines: the pure rules both ends share.
 *
 * The desktop's hub client reaches another machine's backend with the server
 * token narrowed to the `hub` scope (`HUB_REMOTE_AUTH_SCOPES`), and reads
 * what that machine offers through `hub-remote:describe`.
 */
import type { DeviceScope } from './device-auth'
import {
  HUB_BRANCH_RE,
  HUB_DEPS_MODES,
  type HubBatchMachine,
  type HubChildLocation,
  type HubChildPhase,
  type HubDepsMode,
} from './hub'
import { modelsForAgent } from './models'
import { isNetworkCloneUrl, isSafeCloneUrl } from './project-clone'
import { RUNTIME_MODES, type RuntimeMode } from './provider-events'
import { agentLabel, isAgentProvider, type AgentProvider, type AgentType } from './types'

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
  /** Its `hub.minFreeGiB`: the free space a batch must leave there. Absent from an older backend. */
  minFreeGiB?: number
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
  minFreeGiB?: number
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
    ...(f.minFreeGiB !== undefined ? { minFreeGiB: f.minFreeGiB } : {}),
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
/** The backend answers `hub-remote:start-child`: it starts a child for a hub on another machine. */
export const HUB_REMOTE_START_CAPABILITY = 'hub_remote_start_v1'

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
  /** The machine's backend answers `hub-remote:start-child` (`hub_remote_start_v1`). */
  canStart: boolean
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
  if (typeof d.backendVersion !== 'string' || typeof d.openChildren !== 'number' || d.openChildren < 0) return null
  if (d.freeDiskBytes !== null && (typeof d.freeDiskBytes !== 'number' || d.freeDiskBytes < 0)) return null
  if (d.minFreeGiB !== undefined && (typeof d.minFreeGiB !== 'number' || !(d.minFreeGiB >= 0))) return null
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

/** Text from a machine on one line, so a line break cannot start a fake block. */
function oneLine(text: string): string {
  return text.replace(/\p{Cc}/gu, ' ')
}

function machineBlock(e: HubMachineEntry, callerKeys: ReadonlySet<string>): string {
  const age = e.ageMs === null ? '' : e.description ? `, described ${formatAge(e.ageMs)} ago` : ', not described yet'
  const lines = [`${e.id}: ${oneLine(e.name)}`, `  transport ${e.transport}, ${e.status}${age}`]
  if (e.problem) lines.push(`  ${e.problem}`)
  const d = e.description
  if (!d) return lines.join('\n')
  if (!d.flagOn) lines.push('  does not take children: hub_remote_children is off there')
  lines.push(`  os ${oneLine(d.os)} ${oneLine(d.arch)}`)
  if (d.agents.length === 0) lines.push('  agents: none with a login')
  else {
    lines.push('  agents:')
    for (const a of d.agents) {
      const accounts = a.accounts.map((c) => `${oneLine(c.instanceId)} (${oneLine(c.name)})`).join(', ')
      lines.push(`    ${oneLine(a.agent)}: accounts ${accounts}; models ${oneLine(a.models.join(', ')) || 'none'}`)
    }
  }
  lines.push(`  projects with this chat's remote: ${matchingProjects(d.projects, callerKeys)}`)
  const disk = d.freeDiskBytes === null ? 'unknown' : formatGb(d.freeDiskBytes)
  lines.push(`  free disk ${disk}, open children ${d.openChildren}`)
  if (d.runSlots.length > 0) {
    const slots = d.runSlots.map((s) => `${oneLine(s.instanceId)} ${Math.max(0, s.limit - s.running)} of ${s.limit}`)
    lines.push(`  free run slots: ${slots.join(', ')}`)
  }
  return lines.join('\n')
}

function matchingProjects(projects: readonly HubMachineProject[], callerKeys: ReadonlySet<string>): string {
  if (callerKeys.size === 0) return "none (this chat's project has no git remote)"
  const hits = projects.filter((p) => p.remoteUrls.some((u) => callerKeys.has(remoteUrlKey(u) ?? '')))
  if (hits.length === 0) return 'none'
  return hits.map((p) => `${oneLine(p.path)} (${p.branch === null ? 'no branch' : oneLine(p.branch)})`).join(', ')
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

// ─── Proposing a child on another machine ───────────────────────

export const HUB_REMOTE_OFF_TEXT = 'Starting children on other machines is off.'
export const HUB_REMOTE_VM_PARENT_TEXT = 'A chat on a remote machine starts children on its own machine only.'
export const HUB_REMOTE_STOP_LATER_TEXT = 'Stop on another machine comes in a later version.'
export const HUB_REMOTE_READ_LATER_TEXT = 'Reading a child on another machine comes in a later version.'
export const HUB_REMOTE_SETTLE_LATER_TEXT = 'Settling children on other machines comes in a later version'

/** A description older than this is not trusted at propose; `list_machines` reads one every 60 s. */
export const HUB_FRESH_DESCRIPTION_MS = 90_000

/** Where a clone goes on a machine that has no checkout of the project. */
export const HUB_REMOTE_CLONE_ROOT = '~/projects'

/** The machine id a task names, or null for the parent's own machine. */
export function remoteMachineId(machine: string | undefined): string | null {
  return machine && machine !== LOCAL_MACHINE_ID ? machine : null
}

/** What `propose` decides for one task on another machine, before the base commit and disk checks. */
export interface RemoteTaskPlan {
  machine: HubBatchMachine
  instanceId: string
  remoteProjectPath: string
  clonePlanned: boolean
}

/**
 * Checks one task on another machine against that machine's entry (the hub
 * client's cache) and plans where its checkout comes from. The first problem
 * wins; `n` is the task number for the message.
 */
export function planRemoteTask(t: {
  n: number
  machineId: string
  agent: AgentProvider
  account?: string
  model?: string
  location: HubChildLocation
  entries: readonly HubMachineEntry[]
  /** The parent project's git remote URLs. */
  parentRemoteUrls: readonly string[]
  now?: number
}): { ok: true; plan: RemoteTaskPlan } | { ok: false; message: string } {
  const refuse = (text: string) => ({ ok: false as const, message: `Task ${t.n}: ${text}` })
  const e = t.entries.find((x) => x.id === t.machineId)
  if (!e || e.transport === 'local') return refuse(`no machine ${t.machineId}. Call list_machines.`)
  const name = e.name
  if (e.problem) return refuse(`${e.problem}.`)
  if (e.status !== 'connected') return refuse(`connect ${name} first.`)
  const d = e.description
  if (!d || e.ageMs === null || e.ageMs > HUB_FRESH_DESCRIPTION_MS || !e.canStart)
    return refuse(`update the backend on ${name}.`)
  if (!d.flagOn) return refuse(`${name} does not take children: turn on hub_remote_children there.`)
  const label = agentLabel(t.agent)
  const agent = d.agents.find((a) => a.agent === t.agent)
  if (!agent || agent.accounts.length === 0)
    return refuse(`${label} has no login on ${name}. Log in there first (claude, codex login, opencode auth login).`)
  const account = t.account ? agent.accounts.find((c) => c.instanceId === t.account) : agent.accounts[0]
  if (!account) return refuse(`${name} has no ${label} account ${t.account}. Call list_machines.`)
  if (t.model && !agent.models.includes(t.model))
    return refuse(`${name} has no ${label} model ${t.model}. Call list_machines.`)
  if (t.location === 'project')
    return refuse('a child on another machine works in a worktree; location project is refused there.')
  const keys = t.parentRemoteUrls.map(remoteUrlKey).filter((k): k is string => k !== null)
  if (keys.length === 0) return refuse(`this project has no git remote, so ${name} cannot get it.`)
  const machine: HubBatchMachine = { id: e.id, name, transport: e.transport }
  const hit = d.projects.find((p) => p.remoteUrls.some((u) => keys.includes(remoteUrlKey(u) ?? '')))
  if (hit)
    return {
      ok: true,
      plan: { machine, instanceId: account.instanceId, remoteProjectPath: hit.path, clonePlanned: false },
    }
  const repo = repoName(t.parentRemoteUrls.find((u) => remoteUrlKey(u) !== null)!)
  return {
    ok: true,
    plan: {
      machine,
      instanceId: account.instanceId,
      remoteProjectPath: `${HUB_REMOTE_CLONE_ROOT}/${repo}`,
      clonePlanned: true,
    },
  }
}

/** The last path part of a remote URL without `.git`, in its own case. */
function repoName(url: string): string {
  const path = url
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf(':')) + 1)
}

/**
 * The remote branch a child machine fetches the base commit from, out of the
 * remote branches that contain it: the parent's upstream when it is one of
 * them, else the first. Null when no remote branch has the commit.
 */
export function pickFetchBranch(containing: readonly string[], upstream: string | null): string | null {
  if (containing.length === 0) return null
  return upstream && containing.includes(upstream) ? upstream : containing[0]!
}

/** The remote branches in `git branch -r --contains <sha> --format='%(refname:short) %(symref)'` output, without symbolic ones. */
export function parseRemoteBranches(out: string): string[] {
  const branches: string[] = []
  for (const line of out.split('\n')) {
    const [name, symref] = line.trim().split(/\s+/)
    if (name && !symref && !branches.includes(name)) branches.push(name)
  }
  return branches
}

/** Why a task on another machine may not still start at approval, or null. */
export function remoteApprovalProblem(c: {
  machineId: string
  agent: AgentProvider
  instanceId: string | null
  entries: readonly HubMachineEntry[]
}): string | null {
  const e = c.entries.find((x) => x.id === c.machineId)
  if (!e) return `machine ${c.machineId} is gone.`
  if (e.problem) return `${e.problem}.`
  if (e.status !== 'connected') return `${e.name} is not connected.`
  if (!e.description || !e.canStart) return `update the backend on ${e.name}.`
  if (!e.description.flagOn) return `${e.name} does not take children: turn on hub_remote_children there.`
  const accounts = e.description.agents.find((a) => a.agent === c.agent)?.accounts ?? []
  if (!accounts.some((a) => a.instanceId === c.instanceId))
    return `${e.name} no longer has the ${agentLabel(c.agent)} account ${c.instanceId}.`
  return null
}

// ─── Starting a child on another machine ────────────────────────

/** What the desktop sends `hub-remote:start-child`. Ids are the desktop's; the child keeps its id there. */
export interface HubRemoteStartRequest {
  v: 1
  /** The desktop's own id (`hub.installId`): the parent stub there belongs to it. */
  desktopInstallId: string
  /** The parent chat on the desktop; the child machine keeps a stub row under this id. */
  parentId: string
  childId: string
  title: string
  brief: string
  agent: AgentProvider
  /** An account on the child machine. */
  instanceId: string
  model: string | null
  /** The mode the desktop granted; the child machine lowers it to its `hub.remoteMaxMode`. */
  grantedMode: RuntimeMode
  baseSha: string
  /** A branch on the remote at `repoUrl` that holds `baseSha`, without the desktop's remote name. */
  fetch: { remoteBranch: string }
  /** The remote, without credentials (`hubRepoUrl`). */
  repoUrl: string
  /** The checkout there, `~/...` as that machine names it. */
  remoteProjectPath: string
  /** No checkout there: clone `repoUrl` into `remoteProjectPath` first. */
  clonePlanned: boolean
  /** The dependency setting the approved plan recorded (the desktop's `hub.childDependencies` then). */
  deps: HubDepsMode
  /** The task's explicit branch seed (`HUB_BRANCH_RE`); absent or null: the title. */
  branch?: string | null
}

/** Why a child machine refused, when the desktop words it with the machine's name. */
export type HubRemoteRefusal = { kind: 'flag_off' } | { kind: 'cap'; open: number; limit: number }

export type HubRemoteStartAnswer =
  | { ok: true; phase: Extract<HubChildPhase, 'starting' | 'open'>; mode: RuntimeMode }
  | { ok: false; error: string; refusal?: HubRemoteRefusal }

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const MAX_BRIEF = 64 * 1024

/** A start request off the wire: every field is checked, nothing is trusted. */
export function parseHubRemoteStartRequest(
  value: unknown,
): { ok: true; request: HubRemoteStartRequest } | { ok: false; message: string } {
  const bad = (field: string) => ({ ok: false as const, message: `The start request has an invalid ${field}.` })
  if (!value || typeof value !== 'object') return bad('body')
  const r = value as Record<string, unknown>
  const str = (k: string, max: number) =>
    typeof r[k] === 'string' && (r[k] as string).length > 0 && (r[k] as string).length <= max
  if (r.v !== 1) return bad('version')
  for (const k of ['desktopInstallId', 'parentId', 'childId', 'instanceId'])
    if (!str(k, 128) || !ID_RE.test(r[k] as string)) return bad(k)
  if (!str('title', 200)) return bad('title')
  if (!str('brief', MAX_BRIEF)) return bad('brief')
  if (typeof r.agent !== 'string' || !isAgentProvider(r.agent)) return bad('agent')
  if (r.model !== null && !str('model', 200)) return bad('model')
  if (typeof r.grantedMode !== 'string' || !(RUNTIME_MODES as readonly string[]).includes(r.grantedMode))
    return bad('grantedMode')
  if (typeof r.baseSha !== 'string' || !SHA_RE.test(r.baseSha)) return bad('baseSha')
  const fetch = r.fetch as Record<string, unknown> | null
  if (
    !fetch ||
    typeof fetch !== 'object' ||
    typeof fetch.remoteBranch !== 'string' ||
    !isBranchName(fetch.remoteBranch)
  )
    return bad('fetch')
  if (typeof r.repoUrl !== 'string' || hubRepoUrlProblem(r.repoUrl) !== null) return bad('repoUrl')
  if (!str('remoteProjectPath', 1024) || remotePathProblem(r.remoteProjectPath as string) !== null)
    return bad('remoteProjectPath')
  if (typeof r.clonePlanned !== 'boolean') return bad('clonePlanned')
  if (typeof r.deps !== 'string' || !(HUB_DEPS_MODES as readonly string[]).includes(r.deps)) return bad('deps')
  // Absent from a desktop that predates it.
  if (r.branch !== undefined && r.branch !== null && (typeof r.branch !== 'string' || !HUB_BRANCH_RE.test(r.branch)))
    return bad('branch')
  return {
    ok: true,
    request: {
      v: 1,
      desktopInstallId: r.desktopInstallId as string,
      parentId: r.parentId as string,
      childId: r.childId as string,
      title: r.title as string,
      brief: r.brief as string,
      agent: r.agent,
      instanceId: r.instanceId as string,
      model: (r.model as string | null) ?? null,
      grantedMode: r.grantedMode as RuntimeMode,
      baseSha: r.baseSha,
      fetch: { remoteBranch: fetch.remoteBranch },
      repoUrl: r.repoUrl,
      remoteProjectPath: r.remoteProjectPath as string,
      clonePlanned: r.clonePlanned,
      deps: r.deps as HubDepsMode,
      branch: typeof r.branch === 'string' ? r.branch : null,
    },
  }
}

/** A start answer off the wire, or null when its shape is wrong. */
export function parseHubRemoteStartAnswer(value: unknown): HubRemoteStartAnswer | null {
  if (!value || typeof value !== 'object') return null
  const a = value as Record<string, unknown>
  if (a.ok === true) {
    if (a.phase !== 'starting' && a.phase !== 'open') return null
    if (typeof a.mode !== 'string' || !(RUNTIME_MODES as readonly string[]).includes(a.mode)) return null
    return { ok: true, phase: a.phase, mode: a.mode as RuntimeMode }
  }
  if (a.ok !== false || typeof a.error !== 'string') return null
  const r = a.refusal as Record<string, unknown> | undefined
  const refusal: HubRemoteRefusal | undefined =
    r?.kind === 'flag_off'
      ? { kind: 'flag_off' }
      : r?.kind === 'cap' && typeof r.open === 'number' && typeof r.limit === 'number'
        ? { kind: 'cap', open: r.open, limit: r.limit }
        : undefined
  return { ok: false, error: a.error.slice(0, 2000), ...(refusal ? { refusal } : {}) }
}

/** The failed wake's text for a refused start on the machine `name`. */
export function hubRemoteStartFailureText(name: string, answer: Extract<HubRemoteStartAnswer, { ok: false }>): string {
  const r = answer.refusal
  if (r?.kind === 'flag_off') return `${name} does not take children: turn on hub_remote_children there.`
  if (r?.kind === 'cap')
    return `${name} runs ${r.open} child${r.open === 1 ? '' : 'ren'} from other machines already (limit ${r.limit}).`
  return `On ${name}: ${answer.error.replace(/\p{Cc}/gu, ' ')}`
}

/** A call that a backend refused for want of the channel: an older backend. Any other call error has no answer. */
export function isNoHandlerError(message: string): boolean {
  return /^no handler: /.test(message)
}

/**
 * A branch name as `git check-ref-format --branch` would take it, without
 * shell or option tricks: no component starts with "." or ends with ".lock",
 * no "..", "@{", "//", control character, space or any of ~^:?*[\, and the
 * name is not "@" or "HEAD", does not start with "-" or "/" and does not end
 * with "/" or ".".
 */
export function isBranchName(name: string): boolean {
  if (!name || name.length > 255 || name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false
  if (name === '@' || name === 'HEAD') return false
  if (/[\x00-\x20~^:?*[\\\x7f]/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//'))
    return false
  return !name.endsWith('.') && !name.split('/').some((p) => p.startsWith('.') || p.endsWith('.lock'))
}

/**
 * The remote URL a child machine gets: credentials out, the rest as written,
 * so that machine's own git and keys reach it. An ssh login name (`git@`)
 * stays, since ssh needs it and it holds no secret; a password, any http
 * user part (often a token), a query and a fragment go. Null for a local
 * path or a URL another machine cannot fetch.
 */
export function hubRepoUrl(url: string): string | null {
  const u = url.trim()
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/@\s]*@)?(.*)$/i.exec(u)
  let out: string
  if (scheme) {
    const proto = scheme[1]!.toLowerCase()
    const user = (scheme[2] ?? '').slice(0, -1)
    const keepUser = (proto === 'ssh' || proto === 'git+ssh') && user !== '' && !user.includes(':')
    out = `${scheme[1]}://${keepUser ? `${user}@` : ''}${scheme[3]}`.replace(/[?#].*$/, '')
  } else out = u
  return hubRepoUrlProblem(out) === null ? out : null
}

/** Why a child machine must not clone or fetch `url`, or null. */
export function hubRepoUrlProblem(url: string): string | null {
  if (url.length > 1024 || !isSafeCloneUrl(url) || !isNetworkCloneUrl(url) || remoteUrlKey(url) === null)
    return 'This remote URL cannot be cloned on another machine.'
  if (/[?#]/.test(url)) return 'The remote URL carries a query or fragment.'
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/@\s]*)@/i.exec(url)
  if (scheme) {
    const proto = scheme[1]!.toLowerCase()
    if ((proto !== 'ssh' && proto !== 'git+ssh') || scheme[2]!.includes(':'))
      return 'The remote URL carries credentials.'
  }
  return null
}

/** Why a project path from the desktop is not one a child machine accepts, or null. */
function remotePathProblem(path: string): string | null {
  if (/[\x00-\x1f\x7f]/.test(path)) return 'control character'
  if (!path.startsWith('/') && !path.startsWith('~/')) return 'not absolute'
  const parts = path
    .slice(path.startsWith('~/') ? 2 : 1)
    .split('/')
    .filter(Boolean)
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..' || p.startsWith('-'))) return 'unsafe part'
  return null
}

/** `~/x` under `home`; any other accepted path as it is. */
export function expandHubPath(path: string, home: string): string {
  return path.startsWith('~/') ? `${home.replace(/\/+$/, '')}/${path.slice(2)}` : path
}
