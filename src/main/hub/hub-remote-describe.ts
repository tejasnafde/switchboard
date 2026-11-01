/**
 * `hub-remote:describe`: what this backend offers a hub on another machine.
 * Reads the facts and hands them to the pure `buildHubMachineDescription`.
 * It answers with `hub_remote_children` off too (`flagOn: false`), so the
 * desktop can say why the machine takes no children.
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
} from '@shared/hub-remote'
import { hubRemoteChildrenEnabled, readHubSettings } from '@shared/hub'
import { AGENT_PROVIDERS, type AgentProvider } from '@shared/types'
import type { BackendHost } from '../backend/host'
import { getProjects, getSetting, listOpenHubChildren } from '../db/database'
import { listProviderInstances } from '../db/provider-instances'
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
}

export async function describeThisMachine(deps: HubDescribeDeps): Promise<HubMachineDescription> {
  const span = perfSpan('hub.remote-describe')
  const [availableAgents, projects, freeDiskBytes] = await Promise.all([
    availableAgentList(deps),
    readProjects(),
    freeDisk(),
  ])
  const description = buildHubMachineDescription({
    flagOn: readFlag(),
    os: platform(),
    arch: arch(),
    backendVersion: deps.backendVersion(),
    availableAgents,
    homeDir: homedir(),
    instances: listProviderInstances(),
    projects,
    freeDiskBytes,
    openChildren: listOpenHubChildren().length,
    runningSlotKeys: deps.runningSlotKeys(),
    runningPerInstance: readHubSettings((key) => getSetting(key)).runningPerInstance,
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
