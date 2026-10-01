/**
 * The landing screen shown when the primary chat slot is empty: which
 * project its composer writes for, how the project chip reads, and why Send
 * may be off. The chat itself is the ordinary per-project draft
 * (`draftSessionId`), so nothing here creates anything.
 */
import type { Project } from '@shared/types'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('chat:landing')

export interface ProjectTarget {
  projectPath: string
  machineId: string
  name: string
  /** `local`, or the remote machine's name. */
  where: string
  /** Latest session activity in this project, 0 when it has none. */
  lastUsedAt: number
}

export interface RemoteProjectsInput {
  remotes: ReadonlyArray<{ id: string; name: string }>
  connections: Readonly<Record<string, string>>
  projects: Readonly<Record<string, readonly Project[] | undefined>>
}

function lastUsedAt(project: Project): number {
  let latest = 0
  for (const session of project.sessions ?? []) {
    if (session.startedAt > latest) latest = session.startedAt
  }
  return latest
}

/** Local projects, then each connected machine's, in the sidebar's order. */
export function buildProjectTargets(local: readonly Project[], remote: RemoteProjectsInput): ProjectTarget[] {
  const all: ProjectTarget[] = local.map((p) => ({
    projectPath: p.path, machineId: 'local', name: p.name, where: 'local', lastUsedAt: lastUsedAt(p),
  }))
  for (const machine of remote.remotes) {
    if (remote.connections[machine.id] !== 'connected') continue
    for (const p of remote.projects[machine.id] ?? []) {
      all.push({ projectPath: p.path, machineId: machine.id, name: p.name, where: machine.name, lastUsedAt: lastUsedAt(p) })
    }
  }
  return all
}

export interface LandingPick {
  projectPath: string
  machineId: string
}

export function sameTarget(a: LandingPick | null | undefined, b: LandingPick | null | undefined): boolean {
  return Boolean(a && b && a.projectPath === b.projectPath && a.machineId === b.machineId)
}

/**
 * The project the landing composer starts on: the one last picked there when
 * its draft still holds something (so typed text comes back after a
 * relaunch), else the most recently used, else the first listed. Ties keep
 * list order, so a local project wins.
 */
export function defaultLandingTarget(
  targets: readonly ProjectTarget[],
  remembered: LandingPick | null,
  hasDraft: (pick: LandingPick) => boolean,
): ProjectTarget | null {
  const kept = targets.find((t) => sameTarget(t, remembered))
  if (kept && hasDraft(kept)) return kept
  let best: ProjectTarget | null = null
  for (const t of targets) {
    if (!best || t.lastUsedAt > best.lastUsedAt) best = t
  }
  return best
}

/** Machine names appear only once projects come from more than one machine. */
export function showMachineNames(targets: readonly ProjectTarget[]): boolean {
  return new Set(targets.map((t) => t.machineId)).size > 1
}

export function landingChipLabel(target: ProjectTarget | null, withMachine: boolean): string {
  if (!target) return 'Add a project'
  return withMachine ? `${target.name} · ${target.where}` : target.name
}

/** Why the landing composer cannot send yet, or null when it can. */
export function landingSendBlock(target: ProjectTarget | null, projectCount: number): string | null {
  if (projectCount === 0) return 'Add a project to start a chat'
  if (!target) return 'Pick a project to start a chat'
  return null
}

const REMEMBERED_KEY = 'sb:landing-project'

export function parseRememberedPick(raw: string | null): LandingPick | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<LandingPick> | null
    if (typeof value?.projectPath !== 'string' || typeof value.machineId !== 'string') return null
    return { projectPath: value.projectPath, machineId: value.machineId }
  } catch (err) {
    log.warn('ignoring an unreadable remembered landing project', err)
    return null
  }
}

export function readRememberedPick(storage: Pick<Storage, 'getItem'>): LandingPick | null {
  return parseRememberedPick(storage.getItem(REMEMBERED_KEY))
}

export function writeRememberedPick(storage: Pick<Storage, 'setItem'>, pick: LandingPick): void {
  storage.setItem(REMEMBERED_KEY, JSON.stringify({ projectPath: pick.projectPath, machineId: pick.machineId }))
}

export interface MovableDraft<P, I> {
  text: string
  pills: readonly P[]
  images: readonly I[]
}

/**
 * Switching the landing chip carries what was typed to the new project's
 * draft. When that draft already holds text, the moved text goes after it
 * rather than replacing it.
 */
export function mergeMovedDraft<P, I>(
  existing: MovableDraft<P, I> | undefined,
  moved: MovableDraft<P, I>,
): { text: string; pills: P[]; images: I[] } {
  if (!existing) return { text: moved.text, pills: [...moved.pills], images: [...moved.images] }
  const text = existing.text && moved.text ? `${existing.text}\n\n${moved.text}` : existing.text || moved.text
  return {
    text,
    pills: [...existing.pills, ...moved.pills],
    images: [...existing.images, ...moved.images],
  }
}

/**
 * The new-chat shortcut. With no chat in the primary slot the landing
 * composer is already a new chat, so the shortcut returns to it instead of
 * asking for a project.
 */
export function newChatShortcutTarget(primarySessionId: string | null): 'landing' | 'picker' {
  return primarySessionId === null ? 'landing' : 'picker'
}

/** The landing composer's key in the composer registry (`focusComposer`). */
export const LANDING_COMPOSER_ID = 'landing'
