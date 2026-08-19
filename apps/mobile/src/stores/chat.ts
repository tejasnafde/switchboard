/**
 * Per-thread chat feeds reduced from the RuntimeEvent stream. Mirrors the
 * desktop agent-store semantics but renders as a flat feed (FlatList-friendly)
 * instead of nested message attachments.
 *
 * Thread key = `${connectionId}:${threadId}` - two backends can reuse a
 * threadId without bleed (same reason preload stamps machineId on desktop).
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createDebouncedStorage } from '../lib/debouncedStorage'
import type {
  ProviderKind,
  RuntimeContentEvent,
  RuntimeEvent,
  RuntimeMode,
  ProviderSessionStatus,
  Question,
} from '@shared/provider-events'
import { applyContentText, mergeContentChunks } from '@shared/content-stream'
import { echoMessageId, visibleUserMessageText } from '@shared/provider-events'

export type FeedItem =
  | { kind: 'user'; id: string; text: string; at: number; images?: string[] }
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
  /** Provider + profile the BACKEND says this thread runs on, from any client. */
  provider?: ProviderKind
  instanceId?: string | null
  instanceName?: string | null
  status: ProviderSessionStatus
  runtimeMode: RuntimeMode
  sessionId?: string
  usedTokens?: number
  maxTokens?: number | null
  costUsd?: number
  lastTurnDurationMs?: number
  unread: number
  /** Last time any event touched this thread. Drives cache eviction. */
  updatedAt?: number
  /** Restored from disk rather than fetched this run. The seed path is guarded
   *  on an EMPTY feed, so without this a cached thread looks already-loaded and
   *  the app opens on yesterday's transcript with live events appended. */
  cached?: boolean
}

/** The cache shows the last thing you were reading offline; it is not an
 *  archive, since the backend owns the transcript and a re-seed pulls more. */
export const MAX_CACHED_THREADS = 20
export const MAX_CACHED_ITEMS = 60

/** The most recently touched threads, each holding only its newest items. */
export function prunePersistedThreads(
  threads: Record<string, ThreadState>,
  maxThreads = MAX_CACHED_THREADS,
  maxItems = MAX_CACHED_ITEMS,
): Record<string, ThreadState> {
  const keep = Object.entries(threads)
    .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, maxThreads)
  const out: Record<string, ThreadState> = {}
  for (const [key, thread] of keep) {
    out[key] = {
      ...thread,
      // The tail, because a feed renders newest-last and that is what the user
      // was looking at.
      items: thread.items.length > maxItems ? thread.items.slice(-maxItems) : thread.items,
    }
  }
  return out
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
  /** `id` ties the bubble to its queued message so a failed send can undo it. */
  addUserMessage: (key: string, text: string, images?: string[], id?: string) => void
  markQuestionAnswered: (key: string, requestId: string, answers: string[][]) => void
  markApprovalResolved: (key: string, requestId: string, decision: 'approve' | 'deny') => void
  /** `keepIds` survives the replace. History cannot know about a message still
   *  in the outbox, so seeding over one would take the user's bubble down and
   *  let its echo put a second one back. */
  seedItems: (key: string, items: FeedItem[], keepIds?: string[]) => void
  /** Remove an optimistic user bubble whose message will never be sent. */
  removeUserMessage: (key: string, id: string) => void
  /** Queued: coalesced and applied on the next flush tick. */
  ingest: (connectionId: string, event: RuntimeEvent) => void
  /** Unbatched single-event apply. Used by the flush path and by tests. */
  ingestNow: (connectionId: string, event: RuntimeEvent) => void
  /**
   * Bumped whenever a backend told us it could not replay what we missed, so
   * every feed sourced from it is known-incomplete. Screens depend on this so
   * a re-seed actually re-runs instead of being skipped by a once-per-mount
   * guard.
   */
  staleGeneration: number
  /**
   * Drop cached feeds for one backend and ask screens to re-seed.
   *
   * Clearing is the point: the seed path is guarded on an empty feed, so a
   * transcript with a hole in it would otherwise be treated as already loaded
   * and the hole would survive for the life of the process.
   */
  invalidateConnection: (connectionId: string) => void
}

/**
 * Queue events and drain them on a timer, folding each batch into one set().
 * A streaming agent emits a `content` event per token, and one render per token
 * is what made the feed feel janky. The queue is FIFO, so order holds.
 */
const FLUSH_MS = 50

/** Events a human is waiting on - flushed without waiting for the timer. */
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
  // Collapse chunks for the same message. Lossless because mergeContentChunks
  // is associative, and safe in place because the feed item is located by id.
  const id = contentIdOf(event)
  if (id !== null && event.type === 'content') {
    for (let i = queue.length - 1; i >= 0; i--) {
      const prev = queue[i]
      if (prev.connectionId === connectionId && contentIdOf(prev.event) === id) {
        const merged = mergeContentChunks(prev.event as RuntimeContentEvent, event)
        queue[i] = {
          connectionId,
          event: { ...event, text: merged.text, append: merged.append },
        }
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
  return { ...threads, [key]: { ...t, ...fn(t), updatedAt: Date.now() } }
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

/** Pure per-event reducer, so a whole batch folds into one set(). */
function reduceEvent(t: ThreadState, event: RuntimeEvent, isActive: boolean): Partial<ThreadState> {
      switch (event.type) {
        case 'content': {
          const id = `m-${event.messageId}-${event.streamKind}`
          const existing = findFromEnd(t.items, (i) => i.id === id)
          if (existing && existing.kind === 'text') {
            return {
              items: replaceItem(t.items, (i) => i.id === id, (i) => {
                const item = i as Extract<FeedItem, { kind: 'text' }>
                return { ...item, text: applyContentText(item.text, event) }
              }),
            }
          }
          return {
            items: [
              ...t.items,
              { kind: 'text', id, text: applyContentText(undefined, event), stream: event.streamKind, done: false },
            ],
            // Mirror the desktop rule (agent-store appendMessage): unread
            // bumps once per assistant MESSAGE, not per turn - counts stay
            // consistent across clients watching the same session.
            unread: event.streamKind === 'assistant' && !isActive ? t.unread + 1 : t.unread,
          }
        }
        // A turn sent from another client (desktop, second phone). Our own
        // sends carry an origin we recorded, and were added optimistically.
        case 'user.message': {
          // The echo of our own send carries the id we appended optimistically,
          // so this collapses onto it instead of rendering a second bubble.
          const id = echoMessageId(event.origin ?? String(event.at))
          if (t.items.some((i) => i.id === id)) return {}
          const text = visibleUserMessageText(event.text, event.displayBody)
          if (text === null) return {}
          const images = event.images?.map((image) => image.url)
          return {
            items: [
              ...t.items,
              { kind: 'user', id, text, at: event.at, images: images?.length ? images : undefined },
            ],
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
        case 'session.provider':
          return {
            provider: event.provider,
            instanceId: event.instanceId,
            instanceName: event.instanceName,
          }
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
        // Read on another client. applyEvent already resolved the connection's
        // thread key, so this only has to drop the count.
        case 'thread.read':
          return { unread: 0 }
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

/**
 * Debounced so a streaming turn does not serialize the whole thread map 20
 * times a second on the JS thread while the feed is trying to render.
 */
const cacheStorage = createDebouncedStorage(AsyncStorage)

let resolveCache: () => void = () => undefined
/** Dialling before this can seed a thread only for the rehydrate to land after
 *  and replace it with the stale copy. Waiting is cheaper than reconciling. */
export const chatCacheReady = new Promise<void>((resolve) => {
  resolveCache = resolve
})

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
  threads: {},
  activeKey: null,

  setActive: (key) =>
    set((s) => ({
      activeKey: key,
      threads: key && s.threads[key] ? patchThread(s.threads, key, () => ({ unread: 0 })) : s.threads,
    })),

  setRuntimeMode: (key, mode) =>
    set((s) => ({ threads: patchThread(s.threads, key, () => ({ runtimeMode: mode })) })),

  addUserMessage: (key, text, images, id) =>
    set((s) => ({
      threads: patchThread(s.threads, key, (t) => ({
        items: [...t.items, { kind: 'user', id: id ?? `u-${Date.now()}`, text, at: Date.now(), images }],
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

  removeUserMessage: (key, id) =>
    set((s) => ({ threads: patchThread(s.threads, key, (t) => ({ items: t.items.filter((i) => i.id !== id) })) })),

  seedItems: (key, items, keepIds) =>
    // Clearing `cached` is the point: this feed now came from the backend.
    set((s) => ({
      threads: patchThread(s.threads, key, (t) => {
        // A send can be delivered and still stay queued when the response frame
        // is lost, so history may ALREADY contain the message the outbox is
        // holding. History items are re-keyed `h-<id>`, so the collision is
        // invisible to an id comparison - hence matching on the suffix.
        const seeded = new Set(items.map((i) => i.id))
        const alreadySeeded = (id: string): boolean => seeded.has(id) || seeded.has(`h-${id}`)
        // Kept items go AFTER the history: they are the newest thing the user
        // did, and history by definition predates them.
        const keep = keepIds?.length
          ? t.items.filter((i) => keepIds.includes(i.id) && !alreadySeeded(i.id))
          : []
        return { items: [...items, ...keep], cached: false }
      }),
    })),

  ingest: (connectionId, event) => enqueue(connectionId, event),

  ingestNow: (connectionId, event) =>
    set((s) => ({ threads: applyEvent(s.threads, connectionId, event, s.activeKey) })),

  staleGeneration: 0,

  invalidateConnection: (connectionId) => {
    // Drop the 50ms batch: flushing it after the clear leaves a mid-sentence
    // fragment that the seed guard then treats as a loaded feed.
    resetQueue()
    set((s) => {
      const prefix = `${connectionId}:`
      const threads: Record<string, ThreadState> = {}
      for (const [key, thread] of Object.entries(s.threads)) {
        // Keep the row (its runtime mode and unread count are still valid) but
        // empty the feed, which is the part we can no longer vouch for.
        threads[key] = key.startsWith(prefix) ? { ...thread, items: [] } : thread
      }
      return { threads, staleGeneration: s.staleGeneration + 1 }
    })
  },
    }),
    {
      name: 'sb-chat-cache',
      storage: createJSONStorage(() => cacheStorage),
      // Only the feeds. activeKey and staleGeneration describe this run.
      partialize: (s) => ({ threads: prunePersistedThreads(s.threads) }),
      onRehydrateStorage: () => (state) => {
        if (!state) {
          resolveCache()
          return
        }
        // 'running' would spin for a turn that finished while the app was
        // closed; 'idle' would claim a connection we have not made.
        state.threads = Object.fromEntries(
          Object.entries(state.threads).map(([key, t]) => [
            key,
            { ...t, status: 'connecting' as const, cached: true },
          ]),
        )
        resolveCache()
      },
    },
  ),
)
