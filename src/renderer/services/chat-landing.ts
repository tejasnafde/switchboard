/**
 * The landing screen shown when the primary chat slot is empty: which
 * project its composer writes for, how the project chip reads, and why Send
 * may be off. The chat itself is the ordinary per-project draft
 * (`draftSessionId`), so nothing here creates anything.
 */
import type { Project, SessionSummary } from '@shared/types'
import { isDraftSessionId } from '@shared/new-chat-draft'
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
 * The primary slot shows the landing screen when it holds nothing, or a
 * draft: a draft is a chat not created yet, and the landing screen is where
 * one is written.
 */
export function primaryShowsLanding(primarySessionId: string | null): boolean {
  return primarySessionId === null || isDraftSessionId(primarySessionId)
}

/**
 * The new-chat shortcut. On the landing screen it opens the project chip's
 * picker; anywhere else it goes back to the landing screen.
 */
export function newChatShortcutAction(primarySessionId: string | null): 'pick-project' | 'show-landing' {
  return primaryShowsLanding(primarySessionId) ? 'pick-project' : 'show-landing'
}

/**
 * The project the landing screen opens on when asked for from a chat: that
 * chat's, else the one last picked there, else null.
 */
export function landingPickFor(
  focused: { projectPath?: string; machineId?: string } | undefined,
  remembered: LandingPick | null,
): LandingPick | null {
  if (focused?.projectPath) return { projectPath: focused.projectPath, machineId: focused.machineId ?? 'local' }
  return remembered
}

export interface RecentChat {
  session: SessionSummary
  projectPath: string
  projectName: string
  machineId: string
}

/**
 * "Pick up where you left off": the most recent chats across local projects
 * and connected machines, newest first. A chat listed under two projects
 * appears once.
 */
export function recentLandingChats(
  local: readonly Project[],
  remote: RemoteProjectsInput,
  limit = 3,
): RecentChat[] {
  const sets: Array<{ machineId: string; projects: readonly Project[] }> = [{ machineId: 'local', projects: local }]
  for (const machine of remote.remotes) {
    if (remote.connections[machine.id] !== 'connected') continue
    sets.push({ machineId: machine.id, projects: remote.projects[machine.id] ?? [] })
  }
  const seen = new Set<string>()
  const all: RecentChat[] = []
  for (const { machineId, projects } of sets) {
    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        if (session.agentType === 'terminal') continue
        const key = `${machineId}\u0000${session.id}`
        if (seen.has(key)) continue
        seen.add(key)
        all.push({ session, projectPath: project.path, projectName: project.name, machineId })
      }
    }
  }
  return all.sort((a, b) => b.session.startedAt - a.session.startedAt).slice(0, limit)
}

export interface RecentKeyInput {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  isComposing?: boolean
}

export interface RecentKeyResult {
  /** The highlighted recent chat after the key, or null for none. */
  highlight: number | null
  /** Index of the recent chat to open. */
  open?: number
  /** True when the key belongs to the list and must not reach the composer. */
  consume: boolean
}

const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'])

/**
 * Arrow keys walk the recent chats while the landing composer is empty, and
 * Enter opens the highlighted one. With text in the composer every key is
 * the composer's, and typing or Escape drops the highlight.
 */
export function landingRecentKey(
  input: RecentKeyInput,
  highlight: number | null,
  count: number,
  composerEmpty: boolean,
): RecentKeyResult {
  const pass = (next: number | null): RecentKeyResult => ({ highlight: next, consume: false })
  if (input.isComposing || MODIFIER_KEYS.has(input.key)) return pass(highlight)
  if (input.metaKey || input.ctrlKey || input.altKey) return pass(highlight)
  if (count === 0 || !composerEmpty) return pass(null)
  const current = highlight !== null && highlight < count ? highlight : null
  switch (input.key) {
    case 'ArrowDown':
      if (input.shiftKey) return pass(current)
      return { highlight: current === null ? 0 : Math.min(current + 1, count - 1), consume: true }
    case 'ArrowUp':
      if (input.shiftKey) return pass(current)
      // Up from the first row goes back to the composer.
      return { highlight: current === null ? count - 1 : current === 0 ? null : current - 1, consume: true }
    case 'Enter':
      if (current === null || input.shiftKey) return pass(null)
      return { highlight: null, open: current, consume: true }
    case 'Escape':
      return current === null ? pass(null) : { highlight: null, consume: true }
    default:
      return pass(null)
  }
}

export interface ShortcutHint {
  keys: string
  label: string
}

/**
 * The hint line under the landing screen, read from the live bindings so a
 * rebind shows the real key and an unbound command is left out.
 */
export function landingShortcutHints(labelFor: (id: string) => string): ShortcutHint[] {
  const hints: ShortcutHint[] = []
  const project = labelFor('chat.new')
  if (project) hints.push({ keys: project, label: 'switch project' })
  hints.push({ keys: '↑↓', label: 'recent chats' })
  const prompt = labelFor('chat.quick-prompt')
  if (prompt) hints.push({ keys: prompt, label: 'quick prompt' })
  return hints
}

type ProjectPickerOpener = () => void
let projectPickerOpener: ProjectPickerOpener | null = null

/** The landing screen registers its project chip so cmd+shift+O can open it. */
export function registerLandingProjectPicker(open: ProjectPickerOpener): () => void {
  projectPickerOpener = open
  return () => { if (projectPickerOpener === open) projectPickerOpener = null }
}

/** False when no landing screen is mounted. */
export function openLandingProjectPicker(): boolean {
  if (!projectPickerOpener) return false
  projectPickerOpener()
  return true
}

/** The landing composer's key in the composer registry (`focusComposer`). */
export const LANDING_COMPOSER_ID = 'landing'
