export type ChatSlot = 'primary' | 'secondary'

export interface ChatWorkspaceState {
  primarySessionId: string | null
  secondarySessionId: string | null
  focusedSlot: ChatSlot
  splitRatio: number
}

export type ChatWorkspaceEvent =
  | { type: 'select'; sessionId: string }
  | { type: 'open-beside'; sessionId: string }
  | { type: 'focus'; slot: ChatSlot }
  | { type: 'close'; slot: ChatSlot }
  | { type: 'remove'; sessionId: string }
  | { type: 'rotate'; fromSessionId: string; toSessionId: string }
  | { type: 'restore'; availableSessionIds: readonly string[] }
  | { type: 'forward-target'; sourceSessionId: string; targetSessionId: string }
  | { type: 'set-split-ratio'; ratio: number }

export type CanonicalSessionId = (sessionId: string) => string

export const DEFAULT_CHAT_WORKSPACE: ChatWorkspaceState = {
  primarySessionId: null,
  secondarySessionId: null,
  focusedSlot: 'primary',
  splitRatio: 0.5,
}

const identity: CanonicalSessionId = (sessionId) => sessionId

export function sessionForSlot(state: ChatWorkspaceState, slot: ChatSlot): string | null {
  return slot === 'primary' ? state.primarySessionId : state.secondarySessionId
}

export function slotForSession(
  state: ChatWorkspaceState,
  sessionId: string,
  canonicalId: CanonicalSessionId = identity,
): ChatSlot | null {
  const target = canonicalId(sessionId)
  if (state.primarySessionId && canonicalId(state.primarySessionId) === target) return 'primary'
  if (state.secondarySessionId && canonicalId(state.secondarySessionId) === target) return 'secondary'
  return null
}

export function displayedChatSessionIds(state: ChatWorkspaceState): string[] {
  return [state.primarySessionId, state.secondarySessionId].filter((id): id is string => Boolean(id))
}

export function focusedChatSessionId(state: ChatWorkspaceState): string | null {
  return sessionForSlot(state, state.focusedSlot) ?? state.primarySessionId
}

export const companionSessionId = focusedChatSessionId

export type DualChatShortcutAction = 'open-picker' | 'close-secondary'

export function nextDualChatShortcutAction(
  state: Pick<ChatWorkspaceState, 'secondarySessionId'>,
): DualChatShortcutAction {
  return state.secondarySessionId ? 'close-secondary' : 'open-picker'
}

export function shouldEvictReplacedSession(
  sessionId: string,
  displayedAfterSelection: readonly string[],
): boolean {
  return !displayedAfterSelection.includes(sessionId)
}

export type ChatPresentation = 'split' | 'tabs'

export function nextChatPresentation(
  current: ChatPresentation,
  width: number,
  dataScienceMode: boolean,
  splitDragging: boolean,
): ChatPresentation {
  if (splitDragging) return current
  if (dataScienceMode) return 'tabs'
  if (current === 'split') return width < 720 ? 'tabs' : 'split'
  return width >= 840 ? 'split' : 'tabs'
}

function normalize(
  state: ChatWorkspaceState,
  canonicalId: CanonicalSessionId,
): ChatWorkspaceState {
  let next = state

  if (!next.primarySessionId && next.secondarySessionId) {
    next = {
      ...next,
      primarySessionId: next.secondarySessionId,
      secondarySessionId: null,
      focusedSlot: 'primary',
    }
  }

  if (
    next.primarySessionId
    && next.secondarySessionId
    && canonicalId(next.primarySessionId) === canonicalId(next.secondarySessionId)
  ) {
    next = { ...next, secondarySessionId: null, focusedSlot: 'primary' }
  }

  if (next.focusedSlot === 'secondary' && !next.secondarySessionId) {
    next = { ...next, focusedSlot: 'primary' }
  }

  return next
}

function focusExisting(
  state: ChatWorkspaceState,
  sessionId: string,
  canonicalId: CanonicalSessionId,
): ChatWorkspaceState | null {
  const slot = slotForSession(state, sessionId, canonicalId)
  if (!slot) return null
  return normalize({
    ...state,
    focusedSlot: slot,
  }, canonicalId)
}

export function reconcileChatWorkspace(
  state: ChatWorkspaceState,
  event: ChatWorkspaceEvent,
  canonicalId: CanonicalSessionId = identity,
): ChatWorkspaceState {
  switch (event.type) {
    case 'select': {
      const existing = focusExisting(state, event.sessionId, canonicalId)
      if (existing) return existing
      if (!state.primarySessionId || !state.secondarySessionId) {
        return normalize({ ...state, primarySessionId: event.sessionId, focusedSlot: 'primary' }, canonicalId)
      }
      return normalize({
        ...state,
        primarySessionId: state.focusedSlot === 'primary' ? event.sessionId : state.primarySessionId,
        secondarySessionId: state.focusedSlot === 'secondary' ? event.sessionId : state.secondarySessionId,
      }, canonicalId)
    }

    case 'open-beside': {
      const existing = focusExisting(state, event.sessionId, canonicalId)
      if (existing) return existing
      if (!state.primarySessionId) {
        return normalize({ ...state, primarySessionId: event.sessionId, focusedSlot: 'primary' }, canonicalId)
      }
      return normalize({ ...state, secondarySessionId: event.sessionId, focusedSlot: 'secondary' }, canonicalId)
    }

    case 'focus':
      return event.slot === 'secondary' && !state.secondarySessionId
        ? state
        : { ...state, focusedSlot: event.slot }

    case 'close':
      return event.slot === 'secondary'
        ? normalize({ ...state, secondarySessionId: null, focusedSlot: 'primary' }, canonicalId)
        : normalize({ ...state, primarySessionId: null }, canonicalId)

    case 'remove': {
      const slot = slotForSession(state, event.sessionId, canonicalId)
      if (!slot) return state
      return slot === 'primary'
        ? normalize({ ...state, primarySessionId: null }, canonicalId)
        : normalize({ ...state, secondarySessionId: null }, canonicalId)
    }

    case 'rotate':
      return normalize({
        ...state,
        primarySessionId: state.primarySessionId === event.fromSessionId ? event.toSessionId : state.primarySessionId,
        secondarySessionId: state.secondarySessionId === event.fromSessionId ? event.toSessionId : state.secondarySessionId,
      }, canonicalId)

    case 'restore': {
      const available = new Set(event.availableSessionIds)
      return normalize({
        ...state,
        primarySessionId: state.primarySessionId && available.has(state.primarySessionId) ? state.primarySessionId : null,
        secondarySessionId: state.secondarySessionId && available.has(state.secondarySessionId) ? state.secondarySessionId : null,
      }, canonicalId)
    }

    case 'forward-target': {
      if (canonicalId(event.sourceSessionId) === canonicalId(event.targetSessionId)) return state
      const existing = focusExisting(state, event.targetSessionId, canonicalId)
      if (existing) return existing
      const sourceSlot = slotForSession(state, event.sourceSessionId, canonicalId)
      if (sourceSlot === 'secondary') {
        return normalize({ ...state, primarySessionId: event.targetSessionId, focusedSlot: 'primary' }, canonicalId)
      }
      return normalize({ ...state, secondarySessionId: event.targetSessionId, focusedSlot: 'secondary' }, canonicalId)
    }

    case 'set-split-ratio':
      return { ...state, splitRatio: Math.max(0.2, Math.min(0.8, event.ratio)) }
  }
}
