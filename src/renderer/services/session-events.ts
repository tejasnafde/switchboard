/**
 * Lightweight pub/sub for session lifecycle events (rename, etc).
 * Used to keep Sidebar's local projects state in sync with ChatPanel
 * edits and vice versa - without hoisting state or pulling in a store.
 */
import type { RuntimeEvent } from '@shared/provider-events'
import { useAgentStore } from '../stores/agent-store'
import { writeMachineNotice } from './terminal-registry'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:session-events')

type RenameListener = (sessionId: string, title: string) => void

const renameListeners = new Set<RenameListener>()

export function onSessionRename(cb: RenameListener): () => void {
  renameListeners.add(cb)
  return () => renameListeners.delete(cb)
}

export function emitSessionRename(sessionId: string, title: string): void {
  for (const listener of renameListeners) {
    try { listener(sessionId, title) } catch { /* ignore */ }
  }
}

// ─── Session activity (message sent / turn) ───────────────────────
// Bumps the sidebar's live ordering so the active chat jumps to the top
// with "now" without a reload. The DB (conversations.updated_at) is already
// maintained by saveMessage; this keeps the in-memory list in step.

type ActivityListener = (sessionId: string, timestamp: number) => void

const activityListeners = new Set<ActivityListener>()

export function onSessionActivity(cb: ActivityListener): () => void {
  activityListeners.add(cb)
  return () => activityListeners.delete(cb)
}

export function emitSessionActivity(sessionId: string, timestamp: number = Date.now()): void {
  for (const listener of activityListeners) {
    try { listener(sessionId, timestamp) } catch { /* ignore */ }
  }
}

// ─── Session created ──────────────────────────────────────────────

export interface NewSession {
  id: string
  projectPath: string
  title: string
  startedAt: number
  source: 'switchboard' | 'claude-code' | 'codex'
  agentType?: string
}

type CreatedListener = (session: NewSession) => void

const createdListeners = new Set<CreatedListener>()

export function onSessionCreated(cb: CreatedListener): () => void {
  createdListeners.add(cb)
  return () => createdListeners.delete(cb)
}

export function emitSessionCreated(session: NewSession): void {
  for (const listener of createdListeners) {
    try { listener(session) } catch { /* ignore */ }
  }
}

// ─── Machine-tagged provider events ────────────────────────────────
//
// Two machines can emit the same threadId (a cloned repo yields identical
// Claude session UUIDs); events whose machineId disagrees with the target
// session's bound machine are dropped so the streams don't merge.

/** Pure predicate - exported for unit testing without touching the store. */
export function shouldDeliverProviderEvent(
  session: { machineId?: string } | undefined,
  eventMachineId: string | undefined,
): boolean {
  if (!session?.machineId || !eventMachineId) return true
  return session.machineId === eventMachineId
}

/** window.api.provider.onEvent with cross-machine bleed filtered out. */
export function onProviderEvent(callback: (event: RuntimeEvent) => void): () => void {
  return window.api.provider.onEvent((event) => {
    if (event.threadId) {
      const session = useAgentStore.getState().sessions.find((s) => s.id === event.threadId)
      if (!shouldDeliverProviderEvent(session, event.machineId)) {
        log.debug('dropping cross-machine event', {
          threadId: event.threadId,
          sessionMachine: session?.machineId,
          eventMachine: event.machineId,
        })
        return
      }
    }
    callback(event)
  })
}

// ─── Reconnect resync ───────────────────────────────────────────────
//
// A remote machine's server process is a child of the ssh tunnel command -
// a tunnel drop kills it. Auto-reconnect gets a fresh server with no live
// sessions, so anything that was 'running' on that machine is now stale and
// any machine-bound terminal pane's remote shell is gone.

type MachineConnStatus = 'connecting' | 'connected' | 'error' | 'offline'

export type MachineTransition = 'lost' | 'reconnected' | null

/**
 * Leaving 'connected' (a drop -> error, or a manual disconnect -> offline)
 * means the remote server - a child of the ssh tunnel - just died, so its
 * sessions are stale: 'lost'. Coming back to 'connected' after a loss is
 * 'reconnected'. `wasLost` is threaded in (not derived from prevStatus)
 * because auto-reconnect passes through 'connecting', so the direct
 * error->connected edge never occurs. Pure so the matrix is unit-testable.
 */
export function decideMachineTransition(
  prevStatus: MachineConnStatus | undefined,
  nextStatus: MachineConnStatus,
  wasLost: boolean,
): MachineTransition {
  if ((nextStatus === 'error' || nextStatus === 'offline') && prevStatus === 'connected') return 'lost'
  if (nextStatus === 'connected' && wasLost) return 'reconnected'
  return null
}

const prevMachineStatus = new Map<string, MachineConnStatus>()
const lostMachines = new Set<string>()
let reconnectResyncStarted = false

function isMachineConnStatus(status: string): status is MachineConnStatus {
  return status === 'connecting' || status === 'connected' || status === 'error' || status === 'offline'
}

/**
 * Applies the reconnect-resync side effects (terminal notices + resetting
 * stale 'running' sessions) on machine status transitions. Idempotent -
 * only the first call subscribes.
 */
export function initMachineReconnectResync(): () => void {
  if (reconnectResyncStarted) return () => {}
  reconnectResyncStarted = true

  return window.api.machines.onStatus((machineId, status) => {
    if (!isMachineConnStatus(status)) return
    const transition = decideMachineTransition(prevMachineStatus.get(machineId), status, lostMachines.has(machineId))
    prevMachineStatus.set(machineId, status)

    if (status === 'connected') {
      // Disconnect wipes session-id bindings (forgetMachine) and reconnect only
      // restores project paths - rebind open sessions so their id-keyed IPC
      // doesn't silently route to the local backend. Idempotent.
      for (const s of useAgentStore.getState().sessions) {
        if (s.machineId === machineId) window.api.routing.bind(s.id, machineId)
      }
    }

    if (transition === 'lost') {
      lostMachines.add(machineId)
      // The remote server is gone - reset its in-flight sessions now, not on a
      // later reconnect that may never come, so nothing spins forever.
      useAgentStore.getState().resetRunningSessionsForMachine(machineId)
      writeMachineNotice(machineId, `[connection to ${machineId} lost]`)
    } else if (transition === 'reconnected') {
      lostMachines.delete(machineId)
      writeMachineNotice(machineId, "[machine reconnected - this terminal's remote shell is gone, open a new one]")
    }
  })
}

/** Test-only: clears the singleton guard + transition memory between test cases. */
export function __resetMachineReconnectResyncForTests(): void {
  reconnectResyncStarted = false
  prevMachineStatus.clear()
  lostMachines.clear()
}

// This module is imported early (App.tsx, Sidebar, ChatPanel), so subscribing
// at load time needs no dedicated call site. Guarded for vitest's node env.
if (typeof window !== 'undefined' && window.api?.machines) {
  initMachineReconnectResync()
}
