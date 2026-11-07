/**
 * The rules behind the Instinct bridge panels: how the project list filters,
 * sorts and counts, and what each setup step shows. Pure, so the panels only
 * render.
 */
import type { BridgeDeviceStatus, BridgeProjectSetupRow } from '@shared/bridge'

/** The projects panel fires this after a save, so the setup checklist re-reads its count. */
export const BRIDGE_PROJECTS_CHANGED = 'sb-bridge-projects-changed'

/**
 * The device panel polls the enrollment and passes each answer on in this
 * event's `detail`, so the setup checklist shows the same state without a
 * second poll of its own. A failed read carries null.
 */
export const BRIDGE_DEVICE_STATUS = 'sb-bridge-device-status'
export type BridgeDeviceStatusEvent = CustomEvent<BridgeDeviceStatus | null>

/** Allowed first, then by name, so the choices made stay at the top of a long list. */
export function sortBridgeProjects(rows: readonly BridgeProjectSetupRow[]): BridgeProjectSetupRow[] {
  return [...rows].sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.name.localeCompare(b.name))
}

/** Search matches the project name and its folder. */
export function filterBridgeProjects(rows: readonly BridgeProjectSetupRow[], query: string): BridgeProjectSetupRow[] {
  const needle = query.trim().toLowerCase()
  const sorted = sortBridgeProjects(rows)
  if (!needle) return sorted
  return sorted.filter((row) => `${row.name} ${row.path}`.toLowerCase().includes(needle))
}

/** "3 of 41 allowed", with the shown count only while a search hides some. */
export function bridgeProjectCountText(total: number, allowed: number, shown: number): string {
  const base = `${allowed} of ${total} allowed`
  return shown === total ? base : `${base} · ${shown} shown`
}

/** A project can be switched only while its folder resolves to an id. */
export function switchableBridgeProjects(rows: readonly BridgeProjectSetupRow[]): BridgeProjectSetupRow[] {
  return rows.filter((row) => row.projectId !== null)
}

/** The box above the list allows every shown project, or takes them all off once they are allowed. */
export function allShownAllowed(rows: readonly BridgeProjectSetupRow[]): boolean {
  const switchable = switchableBridgeProjects(rows)
  return switchable.length > 0 && switchable.every((row) => row.allowed)
}

export type BridgeStepState = 'done' | 'todo' | 'unknown'

export interface BridgeSetupStep {
  title: string
  state: BridgeStepState
  detail: string
}

/** The enrollment step reads the status, never the stored key alone: an unusable key shows no command. */
function enrollStep(device: BridgeDeviceStatus | null): { state: BridgeStepState; detail: string } {
  if (device === null) return { state: 'unknown', detail: 'Could not read the enrollment.' }
  switch (device.state) {
    case 'connected':
      return { state: 'done', detail: 'Connected to the relay' }
    case 'key_unreadable':
      return { state: 'todo', detail: 'The device key cannot be used here. Remove the enrollment and enroll again.' }
    case 'not_enrolled':
    case 'off':
      return { state: 'todo', detail: 'No device key yet' }
    default:
      return { state: 'todo', detail: 'Key made. Register it at the relay with the command below.' }
  }
}

/**
 * The four setup steps with what this Mac can honestly say about each. Step 1
 * is done because the panel shows only while the flag is on; step 4 happens in
 * Instinct and in Secret Manager, so nothing here can check it.
 */
export function bridgeSetupSteps(input: {
  total: number
  allowed: number
  device: BridgeDeviceStatus | null
}): BridgeSetupStep[] {
  const { device } = input
  return [
    { title: 'Turn on the bridge', state: 'done', detail: 'On' },
    {
      title: 'Choose the projects',
      state: input.allowed > 0 ? 'done' : 'todo',
      detail: bridgeProjectCountText(input.total, input.allowed, input.total),
    },
    { title: 'Enroll this Mac', ...enrollStep(device) },
    {
      title: 'Add the assistant key to Instinct',
      state: 'unknown',
      detail: 'Not checked here. The key lives in Secret Manager and in Instinct.',
    },
  ]
}
