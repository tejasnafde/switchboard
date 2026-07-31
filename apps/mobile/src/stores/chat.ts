/**
 * Per-thread chat feeds reduced from the RuntimeEvent stream. Mirrors the
 * desktop agent-store semantics but renders as a flat feed (FlatList-friendly)
 * instead of nested message attachments.
 *
 * Thread key = `${connectionId}:${threadId}` - two backends can reuse a
 * threadId without bleed (same reason preload stamps machineId on desktop).
 */
import { create } from 'zustand'
import type {
  RuntimeEvent,
  RuntimeMode,
  ProviderSessionStatus,
  Question,
} from '@shared/provider-events'

export type FeedItem =
  | { kind: 'user'; id: string; text: string; at: number }
  | { kind: 'text'; id: string; text: string; stream: 'assistant' | 'reasoning' | 'plan'; done: boolean; durationMs?: number }
  | { kind: 'tool'; id: string; toolName: string; input: unknown; output?: string; state: 'running' | 'done' }
  | { kind: 'denial'; id: string; toolName: string; reason: string }
  | { kind: 'approval'; id: string; requestId: string; toolName: string; detail: string; requestType: string; state: 'pending' | 'approve' | 'deny' }
  | { kind: 'question'; id: string; requestId: string; questions: Question[]; answers?: string[][] }
  | { kind: 'plan'; id: string; planId: string; markdown: string }
  | { kind: 'fileEdit'; id: string; relPath: string; changeKind: 'add' | 'modify' | 'delete'; oldContent: string; newContent: string }
  | { kind: 'error'; id: string; message: string }
  /** Non-agent row the UI inserts itself, e.g. "showing last N of M messages". */
  | { kind: 'notice'; id: string; text: string }

export interface ThreadState {
  items: FeedItem[]
  status: ProviderSessionStatus
  runtimeMode: RuntimeMode
  sessionId?: string
  usedTokens?: number
  maxTokens?: number | null
  costUsd?: number
  lastTurnDurationMs?: number
  unread: number
}

export function threadKey(connectionId: string, threadId: string): string {
  return `${connectionId}:${threadId}`
}

export const emptyThread = (): ThreadState => ({
  items: [],
  status: 'connecting',
  runtimeMode: 'sandbox',
  unread: 0,
})

interface ChatState {
  threads: Record<string, ThreadState>
  /** Thread currently on screen - its events don't bump unread. */
  activeKey: string | null
  setActive: (key: string | null) => void
  setRuntimeMode: (key: string, mode: RuntimeMode) => void
  addUserMessage: (key: string, text: string) => void
  markQuestionAnswered: (key: string, requestId: string, answers: string[][]) => void
  markApprovalResolved: (key: string, requestId: string, decision: 'approve' | 'deny') => void
  seedItems: (key: string, items: FeedItem[]) => void
  /** Queued: coalesced and applied on the next flush tick. */
  ingest: (connectionId: string, event: RuntimeEvent) => void
  /** Unbatched single-event apply. Used by the flush path and by tests. */
  ingestNow: (connectionId: string, event: RuntimeEvent) => void
}

/**
 * Event coalescing.
 *
 * A streaming agent emits a `content` event per token. Applying each one
 * immediately meant one zustand set() and one React render per token, which on
 * a phone rendering a long inverted feed is the whole "streaming feels janky"
 * complaint. The desktop gets away with unbatched dispatch because it is not a
 * phone; it has `streamingBuffer` for the same reason at a coarser grain.
 *
 * So: queue events and drain them on a short timer, folding the batch into ONE
 * set(). Two rules keep this honest:
 *
 *  - Order is preserved. The queue is FIFO and non-content events are queued
 *    too, so a tool card can never overtake the text that preceded it.
 *  - Interactive events flush immediately (after the events queued ahead of
 *    them), so an approval prompt or an error is never sitting in a buffer
 *    waiting on a timer.
 */
const FLUSH_MS = 50

/** Events a human is waiting on - never worth delaying for batching. */
const FLUSH_IMMEDIATELY: ReadonlySet<RuntimeEvent['type']> = new Set([
  'request.opened',
  'request.closed',
  'question.asked',
  'question.answered',
  'plan.proposed',
  'turn.completed',
  'error',
  'status',
])

interface QueuedEvent {
  connectionId: string
  event: RuntimeEvent
}

let queue: QueuedEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null

function contentIdOf(e: RuntimeEvent): string | null {
  return e.type === 'content' ? `${e.threadId}:${e.messageId}:${e.streamKind}` : null
}

function enqueue(connectionId: string, event: RuntimeEvent): void {
  // Collapse consecutive deltas for the same message. `content` carries the
  // full accumulated text, so an older delta is pure garbage once a newer one
  // arrives - dropping it is lossless, not sampling.
  //
  // Replacing IN PLACE is safe even when other events sit in between. The feed
  // item for a message is created by its first delta and thereafter located by
  // id, so a later delta only ever rewrites that item's text - it never depends
  // on queue position. Order relative to interleaved tool/approval events is
  // therefore unchanged.
  const id = contentIdOf(event)
  if (id !== null) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const prev = queue[i]
      if (prev.connectionId === connectionId && contentIdOf(prev.event) === id) {
        queue[i] = { connectionId, event }
        return
      }
    }
  }
  queue.push({ connectionId, event })

  if (FLUSH_IMMEDIATELY.has(event.type)) {
    flushQueue()
    return
  }
  if (timer === null) timer = setTimeout(flushQueue, FLUSH_MS)
}

/** Apply everything queued in a single store write. Exported for tests. */
export function flushQueue(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (queue.length === 0) return
  const batch = queue
  queue = []
  useChatStore.setState((s) => {
    let threads = s.threads
    for (const q of batch) threads = applyEvent(threads, q.connectionId, q.event, s.activeKey)
    return { threads }
  })
}

/** Drop pending events without applying them. Test/teardown hook. */
export function resetQueue(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  queue = []
}

/** Immutable update of one thread. */
function patchThread(
  threads: Record<string, ThreadState>,
  key: string,
  fn: (t: ThreadState) => Partial<ThreadState>,
): Record<string, ThreadState> {
  const t = threads[key] ?? emptyThread()
  return { ...threads, [key]: { ...t, ...fn(t) } }
}

/**
 * Replace the item with matching predicate; no-op when absent.
 *
 * Scans from the END. Everything this is used for - the message currently
 * streaming, the tool that just finished, the approval just answered - lives at
 * or near the tail, while scanning forward walked the whole history on every
 * token. On a 2800-message thread that was ~2800 comparisons per delta.
 */
function replaceItem(items: FeedItem[], match: (i: FeedItem) => boolean, patch: (i: FeedItem) => FeedItem): FeedItem[] {
  for (let idx = items.length - 1; idx >= 0; idx--) {
    if (!match(items[idx])) continue
    const next = items.slice()
    next[idx] = patch(items[idx])
    return next
  }
  return items
}

/** Same tail-first reasoning as replaceItem. */
function findFromEnd(items: FeedItem[], match: (i: FeedItem) => boolean): FeedItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i])) return items[i]
  return undefined
}

/**
 * Pure per-event reducer. Extracted from the store so `flush` can fold a whole
 * batch of events into ONE set() call instead of one per event.
 */
function reduceEvent(t: ThreadState, event: RuntimeEvent, isActive: boolean): Partial<ThreadState> {
      switch (event.type) {
        case 'content': {
          const id = `m-${event.messageId}-${event.streamKind}`
          const existing = findFromEnd(t.items, (i) => i.id === id)
          if (existing && existing.kind === 'text') {
            // REPLACE, do not append. The adapters ship the full accumulated
            // text on every delta (claude-adapter.ts builds `fullText` before
            // emitting; the desktop's streamingBuffer says the same). Appending
            // concatenated cumulative onto cumulative and visibly duplicated
            // every streamed reply.
            return {
              items: replaceItem(t.items, (i) => i.id === id, (i) => ({
                ...(i as Extract<FeedItem, { kind: 'text' }>),
                text: event.text,
              })),
            }
          }
          return {
            items: [...t.items, { kind: 'text', id, text: event.text, stream: event.streamKind, done: false }],
            // Mirror the desktop rule (agent-store appendMessage): unread
            // bumps once per assistant MESSAGE, not per turn - counts stay
            // consistent across clients watching the same session.
            unread: event.streamKind === 'assistant' && !isActive ? t.unread + 1 : t.unread,
          }
        }
        case 'tool.started':
          return {
            items: [
              ...t.items,
              { kind: 'tool', id: `t-${event.toolId}`, toolName: event.toolName, input: event.input, state: 'running' },
            ],
          }
        case 'tool.completed':
          return {
            items: replaceItem(t.items, (i) => i.id === `t-${event.toolId}`, (i) => ({
              ...(i as Extract<FeedItem, { kind: 'tool' }>),
              output: event.output,
              state: 'done' as const,
            })),
          }
        case 'tool.denied':
          return {
            items: [
              ...t.items,
              { kind: 'denial', id: `d-${Date.now()}`, toolName: event.toolName, reason: event.reason },
            ],
          }
        case 'request.opened':
          return {
            items: [
              ...t.items,
              {
                kind: 'approval',
                id: `a-${event.requestId}`,
                requestId: event.requestId,
                toolName: event.toolName,
                detail: event.detail,
                requestType: event.requestType,
                state: 'pending',
              },
            ],
          }
        case 'request.closed':
          return {
            items: replaceItem(
              t.items,
              (i) => i.kind === 'approval' && i.requestId === event.requestId,
              (i) => ({ ...(i as Extract<FeedItem, { kind: 'approval' }>), state: event.decision }),
            ),
          }
        case 'question.asked':
          return {
            items: [
              ...t.items,
              { kind: 'question', id: `q-${event.requestId}`, requestId: event.requestId, questions: event.questions },
            ],
          }
        case 'question.answered':
          return {
            items: replaceItem(
              t.items,
              (i) => i.kind === 'question' && i.requestId === event.requestId,
              (i) => ({ ...(i as Extract<FeedItem, { kind: 'question' }>), answers: event.answers }),
            ),
          }
        case 'plan.proposed':
          return {
            items: [...t.items, { kind: 'plan', id: `p-${event.planId}`, planId: event.planId, markdown: event.planMarkdown }],
          }
        case 'file.edited':
          return {
            items: [
              ...t.items.filter((i) => i.id !== `f-${event.fileEditId}`), // re-edit within a turn coalesces
              {
                kind: 'fileEdit',
                id: `f-${event.fileEditId}`,
                relPath: event.relPath,
                changeKind: event.changeKind,
                oldContent: event.oldContent,
                newContent: event.newContent,
              },
            ],
          }
        case 'turn.completed': {
          // Mark all texts done; stamp duration on the last assistant text.
          const lastIdx = t.items.findLastIndex((i) => i.kind === 'text' && i.stream === 'assistant')
          const items = t.items.map((i, idx) => {
            if (i.kind === 'text') {
              return { ...i, done: true, ...(idx === lastIdx ? { durationMs: event.durationMs } : {}) }
            }
            // A tool card spins while state === 'running'. If tool.completed
            // never arrives (or its id does not match) the spinner never stops,
            // which showed as several cards spinning at once. The turn ending
            // is proof nothing is still running.
            if (i.kind === 'tool' && i.state === 'running') return { ...i, state: 'done' as const }
            return i
          })
          return {
            items,
            status: 'idle' as const,
            usedTokens: event.usedTokens ?? t.usedTokens,
            maxTokens: event.maxTokens ?? t.maxTokens,
            costUsd: event.costUsd ?? t.costUsd,
            lastTurnDurationMs: event.durationMs,
          }
        }
        case 'status':
          return { status: event.status }
        case 'session':
          return { sessionId: event.sessionId }
        case 'context_window':
          // Codex emits maxTokens: null while the model limit is unknown -
          // keep a previously-learned limit instead of blanking the meter.
          return {
            usedTokens: event.usedTokens,
            maxTokens: event.maxTokens ?? t.maxTokens,
            costUsd: event.costUsd ?? t.costUsd,
          }
        case 'error':
          return {
            items: [...t.items, { kind: 'error', id: `e-${Date.now()}`, message: event.message }],
            status: 'error' as const,
          }
        default:
          return {}
      }
}

function applyEvent(
  threads: Record<string, ThreadState>,
  connectionId: string,
  event: RuntimeEvent,
  activeKey: string | null,
): Record<string, ThreadState> {
  const key = threadKey(connectionId, event.threadId)
  return patchThread(threads, key, (t) => reduceEvent(t, event, activeKey === key))
}

export const useChatStore = create<ChatState>((set) => ({
  threads: {},
  activeKey: null,

  setActive: (key) =>
    set((s) => ({
      activeKey: key,
      threads: key && s.threads[key] ? patchThread(s.threads, key, () => ({ unread: 0 })) : s.threads,
    })),

  setRuntimeMode: (key, mode) =>
    set((s) => ({ threads: patchThread(s.threads, key, () => ({ runtimeMode: mode })) })),

  addUserMessage: (key, text) =>
    set((s) => ({
      threads: patchThread(s.threads, key, (t) => ({
        items: [...t.items, { kind: 'user', id: `u-${Date.now()}`, text, at: Date.now() }],
        status: 'running',
      })),
    })),

  markQuestionAnswered: (key, requestId, answers) =>
    set((s) => ({
      threads: patchThread(s.threads, key, (t) => ({
        items: replaceItem(
          t.items,
          (i) => i.kind === 'question' && i.requestId === requestId,
          (i) => ({ ...(i as Extract<FeedItem, { kind: 'question' }>), answers }),
        ),
      })),
    })),

  markApprovalResolved: (key, requestId, decision) =>
    set((s) => ({
      threads: patchThread(s.threads, key, (t) => ({
        items: replaceItem(
          t.items,
          (i) => i.kind === 'approval' && i.requestId === requestId,
          (i) => ({ ...(i as Extract<FeedItem, { kind: 'approval' }>), state: decision }),
        ),
      })),
    })),

  seedItems: (key, items) =>
    set((s) => ({ threads: patchThread(s.threads, key, () => ({ items })) })),

  ingest: (connectionId, event) => enqueue(connectionId, event),

  ingestNow: (connectionId, event) =>
    set((s) => ({ threads: applyEvent(s.threads, connectionId, event, s.activeKey) })),
}))
