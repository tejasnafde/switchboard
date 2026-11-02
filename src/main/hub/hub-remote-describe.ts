/**
 * `hub-remote:describe`: what this backend offers a hub on another machine.
 * Reads the facts and hands them to the pure `buildHubMachineDescription`.
 * It answers with `hub_remote_children` off too (`flagOn: false`), so the
 * desktop can say why the machine takes no children.
 *
 * `hub-remote:start-child` is registered here too and runs
 * `HubStarter.startRemote` (`hub-start.ts`), and so are
 * `hub-remote:outbox-pull` and `hub-remote:outbox-ack` (`hub-outbox.ts`).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { arch, homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HubRemoteChannels } from '@shared/ipc-channels'
import {
  buildHubMachineDescription,
  HUB_DESCRIBE_MAX_PROJECTS,
  parseGitRemoteFetchUrls,
  type HubMachineDescription,
  type HubMachineProject,
  type HubRemoteStartAnswer,
} from '@shared/hub-remote'
import { hubRemoteChildrenEnabled, readHubSettings } from '@shared/hub'
import { ackHubOutboxItems, pullHubOutbox } from './hub-outbox'
import { AGENT_PROVIDERS, type AgentProvider } from '@shared/types'
import type { BackendHost } from '../backend/host'
import { getProjects, getSetting, listOpenHubChildren } from '../db/database'
import { listProviderInstances, type ProviderInstanceWire } from '../db/provider-instances'
import { checkRemoteProviderAuth, remoteProviderConfigDir } from '../provider/remote-gate'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'

const log = createMainLogger('hub:remote-describe')
const execFileP = promisify(execFile)

const GIT_TIMEOUT_MS = 5_000
/** Repositories read at once. */
const GIT_PARALLEL = 8

export interface HubDescribeDeps {
  backendVersion: () => string
  /** Whether the agent's program runs on this backend. */
  agentAvailable: (agent: AgentProvider) => Promise<boolean>
  runningSlotKeys: () => readonly string[]
  /** Whether an account can sign in here. Absent: every enabled account counts (the desktop's own entry). */
  hasLogin?: (instance: ProviderInstanceWire) => Promise<boolean>
  /** `hub-remote:start-child`: starts a child for a hub on another machine. */
  startChild: (request: unknown) => Promise<HubRemoteStartAnswer>
}

export function registerHubRemoteHandlers(host: BackendHost, deps: HubDescribeDeps): void {
  // Calls that arrive while one runs share it, so they do not multiply git processes.
  let inFlight: Promise<HubMachineDescription> | null = null
  host.handle(HubRemoteChannels.DESCRIBE, () => {
    inFlight ??= describeThisMachine(deps).finally(() => {
      inFlight = null
    })
    return inFlight
  })
  host.handle(HubRemoteChannels.START_CHILD, (request: unknown) => deps.startChild(request))
  // Answered with the flag off too: work already running there may finish.
  host.handle(HubRemoteChannels.OUTBOX_PULL, (request: unknown) => pullHubOutbox(request))
  host.handle(HubRemoteChannels.OUTBOX_ACK, (request: unknown) => ackHubOutboxItems(request))
}

export async function describeThisMachine(deps: HubDescribeDeps): Promise<HubMachineDescription> {
  const span = perfSpan('hub.remote-describe')
  const [availableAgents, projects, freeDiskBytes, instances] = await Promise.all([
    availableAgentList(deps),
    readProjects(),
    freeDisk(),
    accountsWithLogin(deps),
  ])
  const settings = readHubSettings((key) => getSetting(key))
  const description = buildHubMachineDescription({
    flagOn: readFlag(),
    os: platform(),
    arch: arch(),
    backendVersion: deps.backendVersion(),
    availableAgents,
    homeDir: homedir(),
    instances,
    projects,
    freeDiskBytes,
    openChildren: listOpenHubChildren().length,
    runningSlotKeys: deps.runningSlotKeys(),
    runningPerInstance: settings.runningPerInstance,
    minFreeGiB: settings.minFreeGiB,
  })
  span.end({ agents: description.agents.length, projects: description.projects.length })
  return description
}

function readFlag(): boolean {
  try {
    return hubRemoteChildrenEnabled(process.env, (key) => getSetting(key))
  } catch (err) {
    log.warn('could not read the hub_remote_children flag; it counts as off', err)
    return false
  }
}

async function availableAgentList(deps: HubDescribeDeps): Promise<AgentProvider[]> {
  const checks = await Promise.all(
    AGENT_PROVIDERS.map(async (agent) => {
      try {
        return (await deps.agentAvailable(agent)) ? agent : null
      } catch (err) {
        log.warn(`could not check whether ${agent} runs here`, err)
        return null
      }
    }),
  )
  return checks.filter((a): a is AgentProvider => a !== null)
}

/** The accounts, less those with no login here: an agent left with none is not listed, so a start on it is refused. */
async function accountsWithLogin(deps: HubDescribeDeps): Promise<ProviderInstanceWire[]> {
  const all = listProviderInstances()
  const hasLogin = deps.hasLogin
  if (!hasLogin) return all
  const checks = await Promise.all(
    all.map(async (i) => {
      if (!i.enabled) return false
      try {
        return await hasLogin(i)
      } catch (err) {
        log.warn(`could not check the login of account ${i.id}; it is not listed`, err)
        return false
      }
    }),
  )
  return all.filter((_, n) => checks[n])
}

const LOGIN_ENV_KEYS: Record<'claude-code' | 'codex', readonly string[]> = {
  'claude-code': ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
}

/**
 * On a machine the desktop reaches over SSH, a Claude Code or Codex account
 * counts as signed in only when a child on it would start. The start passes
 * no config folder, so it first checks this process's env and the default
 * folder, before the account's env applies; then the session runs with the
 * account's key or folder. An account whose folder only its encrypted env
 * names is not counted. Other agents count as signed in.
 */
export async function accountHasLogin(i: ProviderInstanceWire): Promise<boolean> {
  if (i.agentType !== 'claude-code' && i.agentType !== 'codex') return true
  const startGate = remoteProviderConfigDir(i.agentType, undefined)
  if (!(await checkRemoteProviderAuth(i.agentType, startGate)).loggedIn) return false
  if (!i.effectiveOauthDir) return false
  if (LOGIN_ENV_KEYS[i.agentType].some((k) => i.envKeys.includes(k))) return true
  if (i.effectiveOauthDir === startGate) return true
  return (await checkRemoteProviderAuth(i.agentType, i.effectiveOauthDir)).loggedIn
}

async function readProjects(): Promise<HubMachineProject[]> {
  const paths = getProjects()
    .map((p) => p.path)
    .slice(0, HUB_DESCRIBE_MAX_PROJECTS)
  const out: HubMachineProject[] = new Array(paths.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const i = next++
      out[i] = await readProject(paths[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(GIT_PARALLEL, paths.length) }, worker))
  return out
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS })
    return stdout
  } catch (err) {
    // Not a repository, a missing folder or a slow disk: this project only.
    log.debug(`git ${args[0]} failed for a project`, err)
    return null
  }
}

async function readProject(path: string): Promise<HubMachineProject> {
  const [head, remotes] = await Promise.all([
    git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(path, ['remote', '-v']),
  ])
  return {
    path,
    branch: head?.trim() || null,
    remoteUrls: remotes ? parseGitRemoteFetchUrls(remotes) : [],
  }
}

/** Free space where a clone would go: `~/projects` when it exists, else home. */
async function freeDisk(): Promise<number | null> {
  const root = join(homedir(), 'projects')
  const at = existsSync(root) ? root : homedir()
  try {
    const s = await statfs(at)
    return s.bavail * s.bsize
  } catch (err) {
    log.warn('could not read free disk space', err)
    return null
  }
}
