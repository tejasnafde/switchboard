/**
 * Settle and its one-level undo on the desktop. The sidebar patches its lists
 * from `onSettledChange` at once, and again from the backend's broadcast, so
 * the row moves before the round trip and every window agrees after it.
 */
import type { ConversationSettledEvent } from '@shared/chat-settle'
import { useAgentStore, type LastUndo } from '../stores/agent-store'
import { useMachineStore } from '../stores/machine-store'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:chat-settle')

type SettledListener = (id: string, settledAt: number | null) => void

const listeners = new Set<SettledListener>()

export function onSettledChange(cb: SettledListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emitSettled(id: string, settledAt: number | null): void {
  for (const listener of listeners) listener(id, settledAt)
}

/** How long Undo (the notice and Cmd+Z) is offered after a settle. */
export const SETTLE_UNDO_MS = 8000

let undoExpiry: ReturnType<typeof setTimeout> | undefined

/** Offer one undo, withdrawn after `SETTLE_UNDO_MS` whether or not the notice is mounted. */
function offerUndo(undo: LastUndo): void {
  useAgentStore.getState().setLastUndo(undo)
  clearTimeout(undoExpiry)
  undoExpiry = setTimeout(() => {
    if (useAgentStore.getState().lastUndo === undo) useAgentStore.getState().setLastUndo(null)
  }, SETTLE_UNDO_MS)
}

export interface SettleTarget {
  id: string
  title: string
  machineId: string
}

function routeTo(target: Pick<SettleTarget, 'id' | 'machineId'>): void {
  if (target.machineId !== 'local') window.api.routing.bind(target.id, target.machineId)
}

/** The machine whose sidebar lists the chat, for an event that does not say. */
function machineOf(id: string): string {
  const projects = useMachineStore.getState().projects
  for (const [machineId, tree] of Object.entries(projects)) {
    if (tree.some((p) => p.sessions.some((s) => s.id === id))) return machineId
  }
  return 'local'
}

export async function settleChat(target: SettleTarget): Promise<void> {
  emitSettled(target.id, Date.now())
  offerUndo({ kind: 'settle', ...target })
  try {
    routeTo(target)
    const result = await window.api.app.settleConversation(target.id)
    if (!result.ok) throw new Error('the chat has no stored row')
  } catch (err) {
    log.warn(`settle failed for ${target.id}; the row comes back`, err)
    emitSettled(target.id, null)
    if (useAgentStore.getState().lastUndo?.id === target.id) useAgentStore.getState().setLastUndo(null)
  }
}

/** Reverse `lastUndo`. Returns the restored chat's id, or null when there was nothing to undo. */
export function undoLastSettle(): string | null {
  const undo = useAgentStore.getState().lastUndo
  if (!undo) return null
  useAgentStore.getState().setLastUndo(null)
  emitSettled(undo.id, null)
  routeTo(undo)
  window.api.app.unsettleConversation(undo.id).catch((err: unknown) => {
    log.warn(`unsettle failed for ${undo.id}`, err)
  })
  return undo.id
}

/** A backend broadcast: patch the lists, and offer Undo when a merged PR settled the chat. */
export function applySettledEvent(event: ConversationSettledEvent): void {
  emitSettled(event.conversationId, event.settledAt)
  if (event.settledAt === null || event.prNumber === undefined) return
  offerUndo({
    kind: 'settle',
    id: event.conversationId,
    title: event.title ?? 'Untitled chat',
    machineId: machineOf(event.conversationId),
    prNumber: event.prNumber,
  })
}
