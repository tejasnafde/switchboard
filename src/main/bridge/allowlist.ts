/**
 * The owner's project allowlist for the Instinct bridge on this desktop. A
 * known project (the sidebar's) is allowed by saving a policy with the
 * defaults (mode auto capped at auto, edits and checks on, publication off)
 * under its realpath; taking it off deletes the policy by id, so a policy
 * whose folder moved or left the sidebar can still be removed. Nothing is
 * allowed until the owner chooses. Reached only through the admin-scoped
 * `bridge:*` channels. The same file holds the owner's Highest mode per
 * project (the widest mode the bridge may drive a chat there in), the named
 * checks and the newest recorded run of each.
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  bridgePolicyModesValid,
  defaultBridgeProjectPolicy,
  parseBridgeCheckDefinitions,
  type BridgeCheckResultRow,
  type BridgeProjectChecksRow,
  type BridgeProjectSetupRow,
} from '@shared/bridge'
import { isRuntimeMode, RUNTIME_MODES, type RuntimeMode } from '@shared/provider-events'
import {
  bridgeCheckDefinitionHash,
  bridgeCheckOutcome,
  deleteBridgeProjectPolicy,
  flagBridgeCheckDefinitionsChanged,
  getBridgeProjectPolicy,
  getProjects,
  hubInstallId,
  latestBridgeCheckRunsForProject,
  listBridgeProjectPolicies,
  projectBridgeCheckRun,
  saveBridgeProjectPolicy,
} from '../db/database'
import { createMainLogger } from '../logger'

const log = createMainLogger('bridge:allowlist')

/** Stable for one checkout on one machine, so allowing it again gives the same id. */
export function bridgeProjectId(machineId: string, root: string): string {
  return `bproj_${createHash('sha256').update(`${machineId}\0${root}`).digest('hex').slice(0, 20)}`
}

/** Folders that did not resolve last time: each is logged once, again only after it resolved in between. */
const unresolved = new Set<string>()

/** A project folder's realpath, or null when it is gone. */
export function bridgeRealpath(path: string): string | null {
  try {
    const real = realpathSync.native(path)
    unresolved.delete(path)
    return real
  } catch (err) {
    if (!unresolved.has(path)) {
      unresolved.add(path)
      log.info('project folder does not resolve', { code: (err as NodeJS.ErrnoException).code })
    }
    return null
  }
}

/**
 * The sidebar's projects, then every policy no sidebar project resolves to
 * (`orphan`: its folder moved or the project left the sidebar), shown as
 * allowed so the owner can take it off.
 */
export function listBridgeProjectSetup(machineId = hubInstallId()): BridgeProjectSetupRow[] {
  const policies = listBridgeProjectPolicies().filter((p) => p.machine_id === machineId)
  const capById = new Map(policies.map((p) => [p.project_id, p.maximum_mode]))
  const rows: BridgeProjectSetupRow[] = getProjects().map((project) => {
    const root = bridgeRealpath(project.path)
    const projectId = root === null ? null : bridgeProjectId(machineId, root)
    const cap = projectId === null ? undefined : capById.get(projectId)
    return {
      path: project.path,
      name: project.name,
      allowed: cap !== undefined,
      projectId,
      orphan: false,
      maximumMode: cap ?? null,
    }
  })
  const shown = new Set(rows.map((r) => r.projectId))
  for (const policy of policies) {
    if (shown.has(policy.project_id)) continue
    rows.push({
      path: policy.canonical_local_root,
      name: policy.label,
      allowed: true,
      projectId: policy.project_id,
      orphan: true,
      maximumMode: policy.maximum_mode,
    })
  }
  return rows
}

/**
 * The checks of every allowed project on this machine, with the newest
 * recorded run per name. A run that was cancelled, flagged or never finished
 * is reported as it is: nothing here turns into a pass.
 */
export function listBridgeChecksSetup(machineId = hubInstallId()): BridgeProjectChecksRow[] {
  return listBridgeProjectPolicies()
    .filter((p) => p.machine_id === machineId)
    .map((policy) => ({
      project_id: policy.project_id,
      label: policy.label,
      checks: policy.checks,
      results: latestBridgeCheckRunsForProject(policy.project_id).map((run): BridgeCheckResultRow => ({
        name: run.name,
        // The panel reads no checkout, so no result here is about the current code.
        status: projectBridgeCheckRun(run, null).status,
        outcome: bridgeCheckOutcome(run),
        exit_code: run.exitCode,
        at: run.endedAt,
      })),
    }))
}

/**
 * Saves the checks the owner chose for one allowed project. Every recorded
 * run of a definition that is no longer configured is flagged, so an old
 * pass never reads as the configured check again.
 */
export function setBridgeProjectChecks(projectId: string, checks: unknown): void {
  const policy = getBridgeProjectPolicy(projectId)
  if (!policy) throw new Error('That project is not on the bridge allowlist.')
  const next = parseBridgeCheckDefinitions(checks)
  const { revision: _revision, updated_at: _updatedAt, ...base } = policy
  saveBridgeProjectPolicy({ ...base, checks: next })
  flagBridgeCheckDefinitionsChanged(projectId, next.map(bridgeCheckDefinitionHash))
  log.info('bridge project checks saved', { projectId, count: next.length })
}

/**
 * Saves the Highest mode of one allowed project: the widest mode the bridge
 * may drive a chat there in. A default mode above the new cap is lowered with
 * it, so a stored policy is always valid. An old policy keeps the mode it was
 * stored with, since nothing here rewrites a project the owner did not touch.
 */
export function setBridgeProjectMaximumMode(projectId: string, mode: unknown): void {
  if (typeof mode !== 'string' || !isRuntimeMode(mode)) throw new Error('That is not a runtime mode.')
  const policy = getBridgeProjectPolicy(projectId)
  if (!policy) throw new Error('That project is not on the bridge allowlist.')
  const { revision: _revision, updated_at: _updatedAt, ...base } = policy
  const next = { ...base, maximum_mode: mode, default_mode: narrower(policy.default_mode, mode) }
  if (!bridgePolicyModesValid(next)) throw new Error('That mode cannot be stored for this project.')
  saveBridgeProjectPolicy(next)
  log.info('bridge project maximum mode saved', { projectId, mode })
}

function narrower(a: RuntimeMode, b: RuntimeMode): RuntimeMode {
  return RUNTIME_MODES.indexOf(a) <= RUNTIME_MODES.indexOf(b) ? a : b
}

/** Takes a project off the allowlist by id, with no folder lookup. */
export function removeBridgeProject(projectId: string): void {
  if (deleteBridgeProjectPolicy(projectId)) log.info('bridge project removed', { projectId })
}

/** Only a project in the sidebar can be allowed; a path the caller made up is refused. */
export function setBridgeProjectAllowed(path: string, allowed: boolean, machineId = hubInstallId()): void {
  const project = getProjects().find((p) => p.path === path)
  if (!project) throw new Error('That folder is not a Switchboard project.')
  const root = bridgeRealpath(project.path)
  if (root === null) throw new Error('That project folder cannot be read.')
  const projectId = bridgeProjectId(machineId, root)
  if (!allowed) {
    removeBridgeProject(projectId)
    return
  }
  // Allowing an allowed project again keeps its policy and revision.
  if (listBridgeProjectPolicies().some((p) => p.project_id === projectId)) return
  saveBridgeProjectPolicy(
    defaultBridgeProjectPolicy({
      project_id: projectId,
      label: project.name,
      machine_id: machineId,
      canonical_local_root: root,
    }),
  )
  log.info('bridge project allowed', { projectId })
}
