/**
 * The owner's project allowlist for the Instinct bridge on this desktop. A
 * known project (the sidebar's) is allowed by saving a policy with the
 * defaults (mode auto capped at auto, edits and checks on, publication off)
 * under its realpath; taking it off deletes the policy by id, so a policy
 * whose folder moved or left the sidebar can still be removed. Nothing is
 * allowed until the owner chooses. Reached only through the admin-scoped
 * `bridge:*` channels.
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { defaultBridgeProjectPolicy, type BridgeProjectSetupRow } from '@shared/bridge'
import {
  deleteBridgeProjectPolicy,
  getProjects,
  hubInstallId,
  listBridgeProjectPolicies,
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
  const allowedIds = new Set(policies.map((p) => p.project_id))
  const rows: BridgeProjectSetupRow[] = getProjects().map((project) => {
    const root = bridgeRealpath(project.path)
    const projectId = root === null ? null : bridgeProjectId(machineId, root)
    return {
      path: project.path,
      name: project.name,
      allowed: projectId !== null && allowedIds.has(projectId),
      projectId,
      orphan: false,
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
    })
  }
  return rows
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
