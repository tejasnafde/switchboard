/**
 * The owner's project allowlist for the Instinct bridge on this desktop. A
 * known project (the sidebar's) is allowed by saving a policy with the
 * defaults (mode auto capped at auto, edits and checks on, publication off)
 * under its realpath; taking it off deletes the policy. Nothing is allowed
 * until the owner chooses. Reached only through the admin-scoped
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

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch (err) {
    log.warn('project folder does not resolve', { code: (err as NodeJS.ErrnoException).code })
    return null
  }
}

export function listBridgeProjectSetup(machineId = hubInstallId()): BridgeProjectSetupRow[] {
  const allowedIds = new Set(
    listBridgeProjectPolicies()
      .filter((p) => p.machine_id === machineId)
      .map((p) => p.project_id),
  )
  return getProjects().map((project) => {
    const root = realpathOrNull(project.path)
    const projectId = root === null ? null : bridgeProjectId(machineId, root)
    return {
      path: project.path,
      name: project.name,
      allowed: projectId !== null && allowedIds.has(projectId),
      projectId,
    }
  })
}

/** Only a project in the sidebar can be allowed; a path the caller made up is refused. */
export function setBridgeProjectAllowed(path: string, allowed: boolean, machineId = hubInstallId()): void {
  const project = getProjects().find((p) => p.path === path)
  if (!project) throw new Error('That folder is not a Switchboard project.')
  const root = realpathOrNull(project.path)
  if (root === null) throw new Error('That project folder cannot be read.')
  const projectId = bridgeProjectId(machineId, root)
  if (!allowed) {
    if (deleteBridgeProjectPolicy(projectId)) log.info('bridge project removed', { projectId })
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
