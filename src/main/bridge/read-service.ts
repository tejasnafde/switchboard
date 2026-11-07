/**
 * The bridge's read side: list_projects, list_recent_chats, search_chats and
 * read_chat over the chats of the projects the owner allowed on this desktop.
 *
 * One typed service. The local MCP wrapper (`mcp/bridge-tools.ts`) calls it
 * for an agent thread, and the relay's dispatcher (`bridge/command-dispatch.ts`)
 * calls the same methods for the owner. Every read is scoped to the allowlist
 * before any ranking or limit, reads chats under their root id
 * (`resolveRootThreadId`), masks text through the stored-secret paths and
 * never returns a local path.
 *
 * Only this desktop answers for now, so lists are never partial and name no
 * unavailable machine. `agent_reply` is what the agent said; `evidence`
 * (`bridge/evidence.ts`) is what this desktop observed itself, and the
 * cursor covers it, so a new measured fact is a change the owner can page to.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  bridgeError,
  emptyBridgeEvidence,
  publicProjectView,
  type BridgeChatRef,
  type BridgeChatWorkState,
  type BridgeError,
  type BridgeEvidence,
} from '@shared/bridge'
import { MESSAGE_SEARCH_LIMIT, SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from '@shared/message-search'
import type { PendingBlockingEvent } from '@shared/pending-requests'
import type { ProviderSessionStatus, RuntimeEvent } from '@shared/provider-events'
import { isAgentType, type AgentType, type ChatMessage } from '@shared/types'
import {
  getConversationById,
  getDb,
  getManagedRootConversationsForProjects,
  getProjects,
  lastMessageAt,
  listBridgeProjectPolicies,
  resolveRootThreadId,
  threadFamilyIds,
  type ConversationRow,
  type StoredBridgeProjectPolicy,
} from '../db/database'
import { searchChatTitlesInDatabase, searchMessagesInDatabase, type SearchResult } from '../db/message-search'
import { maskStoredText } from '../db/secret-mask'
import { loadConversationHistoryWindow } from '../conversations/history'
import { createMainLogger } from '../logger'
import { bridgeRealpath } from './allowlist'
import { jsonBytes, previewText, windowText } from './read-budget'
import { resolveLabel } from './resolve-label'

const log = createMainLogger('bridge:read')

const BRIDGE_LIST_DEFAULT_LIMIT = 20
export const BRIDGE_LIST_MAX_LIMIT = 50
const BRIDGE_SNIPPET_MAX_CHARS = 240
/** Messages a read_chat returns, newest last, and the cap on each one's text. */
const READ_HISTORY_MESSAGES = 20
const READ_MESSAGE_MAX_CHARS = 1000
const PENDING_SUMMARY_MAX_CHARS = 500
/** A title is stored with no length of its own, and a row is not the place to read a long one. */
const READ_TITLE_MAX_CHARS = 200
/** Open questions and approvals one read returns, newest last. */
const READ_PENDING_MAX = 10
/**
 * The whole JSON of one read_chat answer. The relay carries a result in one
 * 64 KiB frame, so this leaves room for the frame's own fields and for the
 * answer growing by a few bytes anywhere above this service.
 */
export const READ_CHAT_BUDGET_BYTES = 48 * 1024
/** The reply keeps at least this much of the room, before any history. */
const READ_REPLY_MIN_BYTES = 8 * 1024
/** Threads whose live activity is remembered; the oldest goes first. */
const ACTIVITY_MAX_THREADS = 500
const CURSOR_PREFIX = 'brc1.'

const ACTIVITY_EVENTS: ReadonlySet<RuntimeEvent['type']> = new Set([
  'content',
  'tool.started',
  'tool.completed',
  'turn.completed',
  'user.message',
])

/** What the provider registry knows about a chat that runs now. */
export interface BridgeLiveState {
  /** The live session's status, or null when no session runs for the chat. */
  status(chatId: string): ProviderSessionStatus | null
  /** A turn runs, is being prepared or is still owed. */
  busy(chatId: string): boolean
  /** Open approvals, questions and plans, masked. */
  pending(chatId: string): PendingBlockingEvent[]
}

export interface BridgeReadDeps {
  live: BridgeLiveState
  /** This desktop's stable machine id. */
  machineId: () => string
  /** Measured facts about the chat's checkout, pull requests and checks. Omitted: everything is `not_measured`. */
  evidence?: (chatId: string) => Promise<BridgeEvidence>
  now?: () => number
}

export interface BridgeProjectRef {
  project_id: string
  label: string
}

interface ResultBase {
  call_id: string
  observed_at: string
  machine_ids: string[]
}

interface ListBase extends ResultBase {
  partial: boolean
  unavailable_machines: string[]
  catalog_age_ms: number
}

export interface BridgeProjectRow extends ReturnType<typeof publicProjectView> {
  online: boolean
  stale: boolean
  last_contact_at: string
  agents: string[]
}

export interface BridgeChatRow {
  chat: BridgeChatRef
  title: string
  project: BridgeProjectRef
  machine_id: string
  last_activity_at: string
  status: BridgeChatWorkState
  archived: boolean
}

export interface BridgeSearchRow extends BridgeChatRow {
  /** Plain text around the matched words, at most 240 characters; null for a title-only hit. */
  snippet: string | null
  matched_on: 'title' | 'message' | 'both'
}

export interface BridgePendingItem {
  kind: 'approval' | 'question' | 'plan'
  request_id: string
  summary: string
}

/**
 * The newest stored reply. `partial` while a turn runs: the reply can still
 * change. A reply too long for one answer is cut to fit; `text` then holds its
 * head and its tail with a marker between them, and `next_offset` reads on.
 */
export interface BridgeReplyChunk {
  message_id: string
  text: string
  at: string
  partial: boolean
  /** Characters in the whole reply, however much of it `text` holds. */
  length: number
  /** Where `text` starts in the whole reply. */
  offset: number
  /** `text` is not all of the reply from `offset` on. */
  truncated: boolean
  /** Pass as `reply_offset` to read the next part in order; null when there is no more. */
  next_offset: number | null
}

/** What the answer had to leave out to fit its size budget. */
export interface BridgeOmitted {
  /** Messages dropped from the history window, oldest first. */
  history: number
  pending: number
  pull_requests: number
  checks: number
}

export interface BridgeChatSnapshot extends ResultBase {
  chat: BridgeChatRef
  title: string
  project: BridgeProjectRef
  archived: boolean
  status: BridgeChatWorkState
  last_activity_at: string
  /** Pass back as `since` to get only what changed. */
  cursor: string
  unchanged: boolean
  agent_reply: BridgeReplyChunk | null
  pending: BridgePendingItem[]
  /** Up to 20 messages, oldest first; after `since`, only the newer ones. */
  history: Array<{ message_id: string; role: 'user' | 'assistant'; text: string; at: string }>
  /** True when `since` named a message no longer in the window, so `history` starts over. */
  history_reset: boolean
  /** Something in this answer was cut to fit, so it is not the whole picture. */
  truncated: boolean
  omitted: BridgeOmitted
  queued_bridge_messages: never[]
  call_receipts: never[]
  /** What this desktop observed, separate from `agent_reply`. Never the agent's own claim. */
  evidence: BridgeEvidence
}

export interface BridgeUnchanged extends ResultBase {
  chat: BridgeChatRef
  unchanged: true
  status: BridgeChatWorkState
  cursor: string
}

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: BridgeError }

export interface AllowedProject {
  policy: StoredBridgeProjectPolicy
  /** The project paths chats are stored under: the realpath and every known path that resolves to it. */
  paths: string[]
  /** The sidebar project's own path, under which a new chat is stored. */
  sidebarPath: string
}

interface CursorBody {
  v: 1
  /** chat, machine, project, policy revision and policy save time */
  c: string
  m: string
  p: string
  r: number
  u: number
  /** digest of the state the snapshot showed */
  k: string
  /** the newest message the snapshot showed */
  l: string | null
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Plain text of a message hit: the marked snippet without its marks, or the fallback scan's excerpt. */
export function plainSnippet(hit: Pick<SearchResult, 'snippet' | 'snippetMarked'>): string {
  const source = hit.snippetMarked ?? hit.snippet
  return cap(
    oneLine(source.split(SNIPPET_MARK_OPEN).join('').split(SNIPPET_MARK_CLOSE).join('')),
    BRIDGE_SNIPPET_MAX_CHARS,
  )
}

/** Default 20; a number is clamped to 1..50. Anything else is refused. */
export function parseBridgeLimit(value: unknown): number | null {
  if (value === undefined || value === null) return BRIDGE_LIST_DEFAULT_LIMIT
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(1, Math.min(BRIDGE_LIST_MAX_LIMIT, Math.floor(value)))
}

function encodeCursor(body: CursorBody): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url')
}

function decodeCursor(cursor: unknown): CursorBody | null {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) return null
  try {
    const body = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')) as CursorBody
    return body && body.v === 1 && typeof body.c === 'string' && typeof body.k === 'string' ? body : null
  } catch (err) {
    log.debug('unreadable read_chat cursor', { err: String(err) })
    return null
  }
}

function pendingItem(event: PendingBlockingEvent): BridgePendingItem {
  if (event.type === 'request.opened')
    return {
      kind: 'approval',
      request_id: event.requestId,
      summary: cap(oneLine(`${event.toolName}: ${event.detail}`), PENDING_SUMMARY_MAX_CHARS),
    }
  if (event.type === 'question.asked')
    return {
      kind: 'question',
      request_id: event.requestId,
      summary: cap(oneLine(event.questions.map((q) => q.question).join(' / ')), PENDING_SUMMARY_MAX_CHARS),
    }
  return {
    kind: 'plan',
    request_id: event.planId,
    summary: cap(oneLine(event.planMarkdown), PENDING_SUMMARY_MAX_CHARS),
  }
}

/** The agents a bridge call may pick in a project: the policy's list, else every agent with an enabled account. */
export function bridgeProjectAgents(policy: Pick<StoredBridgeProjectPolicy, 'allowed_agents'>): AgentType[] {
  if (policy.allowed_agents.length > 0) return [...policy.allowed_agents]
  return (
    getDb()
      .prepare('SELECT DISTINCT agent_type FROM provider_instances WHERE enabled = 1 ORDER BY agent_type')
      .all() as Array<{ agent_type: string }>
  )
    .map((r) => r.agent_type)
    .filter(isAgentType)
}

/**
 * The owner's allowed projects on this desktop, each with the stored paths
 * its chats use. A policy counts only while a sidebar project still resolves
 * to its root: one whose folder moved or that left the sidebar serves nothing.
 */
export function allowedBridgeProjects(machineId: string): AllowedProject[] {
  const policies = listBridgeProjectPolicies().filter((p) => p.machine_id === machineId)
  if (policies.length === 0) return []
  const known = getProjects().map((p) => ({ path: p.path, real: bridgeRealpath(p.path) }))
  return policies.flatMap((policy) => {
    const paths = known.filter((p) => p.real === policy.canonical_local_root).map((p) => p.path)
    return paths.length === 0
      ? []
      : [{ policy, paths: [...new Set([policy.canonical_local_root, ...paths])], sidebarPath: paths[0] }]
  })
}

export class BridgeReadService {
  /** Thread id (as the event named it) to the time of its last runtime activity. */
  private readonly activity = new Map<string, number>()

  constructor(private readonly deps: BridgeReadDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Remember live activity; subscribed to the registry's event bus. */
  noteEvent(event: RuntimeEvent): void {
    if (!ACTIVITY_EVENTS.has(event.type) || !('threadId' in event) || typeof event.threadId !== 'string') return
    this.activity.delete(event.threadId)
    this.activity.set(event.threadId, this.now())
    if (this.activity.size > ACTIVITY_MAX_THREADS) this.activity.delete(this.activity.keys().next().value!)
  }

  private liveActivityByRoot(): Map<string, number> {
    const byRoot = new Map<string, number>()
    for (const [id, at] of this.activity) {
      const root = resolveRootThreadId(id)
      byRoot.set(root, Math.max(at, byRoot.get(root) ?? 0))
    }
    return byRoot
  }

  private base(machineId: string): ResultBase {
    return {
      call_id: `bread_${randomUUID()}`,
      observed_at: new Date(this.now()).toISOString(),
      machine_ids: [machineId],
    }
  }

  private listBase(machineId: string): ListBase {
    return { ...this.base(machineId), partial: false, unavailable_machines: [], catalog_age_ms: 0 }
  }

  allowed(machineId: string): AllowedProject[] {
    return allowedBridgeProjects(machineId)
  }

  private projectOfPath(allowed: AllowedProject[], path: string): AllowedProject | undefined {
    return allowed.find((a) => a.paths.includes(path))
  }

  private workState(chatId: string): BridgeChatWorkState {
    const { live } = this.deps
    if (live.pending(chatId).length > 0) return 'waiting_for_user'
    const status = live.status(chatId)
    if (status === 'connecting') return 'starting'
    if (status === 'running' || live.busy(chatId)) return 'running'
    if (status === 'error') return 'error'
    if (status === 'stopped') return 'stopped'
    return 'idle'
  }

  /** Stored message times and live runtime activity; a chat with neither counts from its creation. */
  private lastActivity(chatId: string, createdAt: number, live: Map<string, number>): number {
    return Math.max(lastMessageAt(threadFamilyIds(chatId)) ?? createdAt, live.get(chatId) ?? 0)
  }

  private chatRow(
    machineId: string,
    project: AllowedProject,
    chat: { id: string; title: string; archived: boolean; activity: number },
  ): BridgeChatRow {
    return {
      chat: { machine_id: machineId, chat_id: chat.id },
      title: cap(maskStoredText(chat.id, chat.title), READ_TITLE_MAX_CHARS),
      project: { project_id: project.policy.project_id, label: project.policy.label },
      machine_id: machineId,
      last_activity_at: new Date(chat.activity).toISOString(),
      status: this.workState(chat.id),
      archived: chat.archived,
    }
  }

  listProjects(): BridgeResult<ListBase & { projects: BridgeProjectRow[] }> {
    const machineId = this.deps.machineId()
    const base = this.listBase(machineId)
    const projects = this.allowed(machineId).map(({ policy }) => ({
      ...publicProjectView(policy),
      online: true,
      stale: false,
      last_contact_at: base.observed_at,
      agents: bridgeProjectAgents(policy),
    }))
    return { ok: true, value: { ...base, projects } }
  }

  /** An exact project id, else its label (exact, then fuzzy). */
  resolveProject(allowed: AllowedProject[], ref: string): BridgeResult<AllowedProject> {
    const byId = allowed.find((a) => a.policy.project_id === ref)
    if (byId) return { ok: true, value: byId }
    const found = resolveLabel(allowed, (a) => a.policy.label, ref)
    if (found.kind === 'one') return { ok: true, value: found.item }
    if (found.kind === 'ambiguous')
      return {
        ok: false,
        error: bridgeError('ambiguous_target', 'Several allowed projects match. Ask the owner which one.', {
          choices: found.choices.map((a) => publicProjectView(a.policy)),
        }),
      }
    return { ok: false, error: bridgeError('project_not_allowed', 'No allowed project matches that name.') }
  }

  listRecentChats(input: { project?: string; limit: number }): BridgeResult<ListBase & { chats: BridgeChatRow[] }> {
    const machineId = this.deps.machineId()
    let scope = this.allowed(machineId)
    if (input.project !== undefined) {
      const project = this.resolveProject(scope, input.project)
      if (!project.ok) return project
      scope = [project.value]
    }
    const byProject = getManagedRootConversationsForProjects(scope.flatMap((a) => a.paths))
    const live = this.liveActivityByRoot()
    const chats = [...byProject.values()]
      .flat()
      .filter((row) => row.agent_type !== 'terminal')
      .map((row) => ({ row, activity: this.lastActivity(row.id, row.created_at, live) }))
      .sort((a, b) => b.activity - a.activity)
      .slice(0, input.limit)
      .map(({ row, activity }) =>
        this.chatRow(machineId, this.projectOfPath(scope, row.project_path)!, {
          id: row.id,
          title: row.title,
          archived: row.archived === 1,
          activity,
        }),
      )
    return { ok: true, value: { ...this.listBase(machineId), chats } }
  }

  /**
   * Titles and stored message text, inside the allowed projects before any
   * ranking or limit, one row per root chat. A chat matching on both comes
   * first, then title-only hits (newest first), then message-only hits in
   * message-search order. "archive" or "archived" in the query includes
   * archived chats, as in global search.
   */
  searchChats(input: { query: string; limit: number }): BridgeResult<ListBase & { chats: BridgeSearchRow[] }> {
    const machineId = this.deps.machineId()
    const scope = this.allowed(machineId)
    const paths = scope.flatMap((a) => a.paths)
    const db = getDb()
    const messageHits = searchMessagesInDatabase(db, input.query, MESSAGE_SEARCH_LIMIT, {
      projectPaths: paths,
      onePerChat: true,
    })
    const titleHits = searchChatTitlesInDatabase(db, input.query, { projectPaths: paths })

    interface Merged {
      id: string
      title: string
      projectPath: string
      archived: boolean
      message: SearchResult | null
      title_match: boolean
    }
    const merged = new Map<string, Merged>()
    for (const hit of messageHits) {
      if (merged.has(hit.conversationId)) continue
      merged.set(hit.conversationId, {
        id: hit.conversationId,
        title: hit.conversationTitle,
        projectPath: hit.projectPath,
        archived: hit.archived === true,
        message: hit,
        title_match: false,
      })
    }
    const titleOnly: Merged[] = []
    for (const hit of titleHits) {
      const known = merged.get(hit.conversationId)
      if (known) known.title_match = true
      else titleOnly.push({ ...hit, id: hit.conversationId, message: null, title_match: true })
    }
    const both = [...merged.values()].filter((m) => m.title_match)
    const messageOnly = [...merged.values()].filter((m) => !m.title_match)
    const live = this.liveActivityByRoot()
    const chats = [...both, ...titleOnly, ...messageOnly].slice(0, input.limit).flatMap((m): BridgeSearchRow[] => {
      const project = this.projectOfPath(scope, m.projectPath)
      const row = getConversationById(m.id)
      if (!project || !row) return []
      return [
        {
          ...this.chatRow(machineId, project, {
            id: m.id,
            title: m.title,
            archived: m.archived,
            activity: this.lastActivity(m.id, row.created_at, live),
          }),
          snippet: m.message ? maskStoredText(m.id, plainSnippet(m.message)) : null,
          matched_on: m.message ? (m.title_match ? 'both' : 'message') : 'title',
        },
      ]
    })
    return { ok: true, value: { ...this.listBase(machineId), chats } }
  }

  /**
   * A chat reference to one root chat in an allowed project: an exact id
   * (any rotated id of the chat), else a title (exact, then fuzzy). A chat
   * outside the allowlist answers like an unknown one.
   */
  resolveChat(
    allowed: AllowedProject[],
    machineId: string,
    ref: unknown,
  ): BridgeResult<{ row: ConversationRow; project: AllowedProject }> {
    const notFound = bridgeError('project_not_allowed', 'No chat in an allowed project matches that reference.')
    let text: string | null = null
    if (typeof ref === 'string') text = ref
    else if (ref && typeof ref === 'object' && typeof (ref as BridgeChatRef).chat_id === 'string') {
      const { machine_id: machine, chat_id: chatId } = ref as BridgeChatRef
      if (machine !== undefined && machine !== machineId)
        return {
          ok: false,
          error: bridgeError(
            'project_not_allowed',
            'That chat belongs to another machine. This desktop reads only its own.',
          ),
        }
      text = chatId
    }
    if (!text?.trim()) return { ok: false, error: notFound }

    const byId = getConversationById(resolveRootThreadId(text))
    if (byId) {
      const project = byId.sidebar_role === 'managed' ? this.projectOfPath(allowed, byId.project_path) : undefined
      return project ? { ok: true, value: { row: byId, project } } : { ok: false, error: notFound }
    }
    const candidates = [...getManagedRootConversationsForProjects(allowed.flatMap((a) => a.paths)).values()]
      .flat()
      .filter((row) => row.agent_type !== 'terminal')
    // Matched on the masked title, so a saved secret in a title is no prefix oracle.
    const found = resolveLabel(candidates, (row) => maskStoredText(row.id, row.title), text)
    if (found.kind === 'one') {
      const project = this.projectOfPath(allowed, found.item.project_path)
      return project ? { ok: true, value: { row: found.item, project } } : { ok: false, error: notFound }
    }
    if (found.kind === 'ambiguous') {
      const titles = found.choices.map((row) => `"${maskStoredText(row.id, row.title)}"`).join(', ')
      return {
        ok: false,
        error: bridgeError('ambiguous_target', `Several chats match: ${titles}. Ask the owner which one.`, {
          choices: found.choices.map((row) => ({ machine_id: machineId, chat_id: row.id })),
        }),
      }
    }
    return { ok: false, error: notFound }
  }

  async readChat(input: {
    chat: unknown
    since?: unknown
    reply_offset?: unknown
  }): Promise<BridgeResult<BridgeChatSnapshot | BridgeUnchanged>> {
    const machineId = this.deps.machineId()
    const allowed = this.allowed(machineId)
    const resolved = this.resolveChat(allowed, machineId, input.chat)
    if (!resolved.ok) return resolved
    const { row, project } = resolved.value
    const chatId = row.id
    const ref: BridgeChatRef = { machine_id: machineId, chat_id: chatId }

    const replyOffset = parseReplyOffset(input.reply_offset)
    if (replyOffset === 'invalid')
      return {
        ok: false,
        error: bridgeError('invalid_request', 'reply_offset must be a whole number of characters, 0 or more.'),
      }

    let since: CursorBody | null = null
    if (input.since !== undefined && input.since !== null) {
      since = decodeCursor(input.since)
      const bound =
        since !== null &&
        since.c === chatId &&
        since.m === machineId &&
        since.p === project.policy.project_id &&
        since.r === project.policy.revision &&
        since.u === project.policy.updated_at
      if (!bound)
        return {
          ok: false,
          error: bridgeError('cursor_expired', 'That cursor no longer applies. Read the chat again without since.', {
            target: ref,
          }),
        }
    }

    const window = await loadConversationHistoryWindow(chatId, { limit: READ_HISTORY_MESSAGES * 2 })
    const messages = window.messages.filter(
      (m): m is ChatMessage & { role: 'user' | 'assistant' } =>
        (m.role === 'user' || m.role === 'assistant') && !m.parentToolCallId && m.content.trim() !== '',
    )
    const status = this.workState(chatId)
    const turnRunning = this.deps.live.status(chatId) === 'running' || this.deps.live.busy(chatId)
    const allPending = this.deps.live.pending(chatId).map(pendingItem)
    // Newest last, as the history is: the oldest open requests give way first.
    const pending = allPending.slice(-READ_PENDING_MAX)
    const reply = [...messages].reverse().find((m) => m.role === 'assistant') ?? null
    const newest = messages.at(-1)?.id ?? null
    const title = maskStoredText(chatId, row.title)
    const base = this.base(machineId)
    const evidence = await this.readEvidence(chatId, base.observed_at)
    // The reply's text, not its length: a rewrite of the same length is a change.
    // `observed_at` is dropped from the evidence, or every read would differ.
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          status,
          window.total,
          newest,
          reply?.id ?? null,
          reply?.content ?? null,
          allPending.map((p) => p.request_id),
          row.archived === 1,
          title,
          evidenceFingerprint(evidence),
        ]),
      )
      .digest('hex')
      .slice(0, 16)
    const cursor = encodeCursor({
      v: 1,
      c: chatId,
      m: machineId,
      p: project.policy.project_id,
      r: project.policy.revision,
      u: project.policy.updated_at,
      // A page of a long reply delivers no history, so it hands back the
      // place and the fingerprint the caller was already at. A change that
      // lands between the first read and the page is then still new to the
      // next `since` read, rather than passing as unchanged and never shown.
      k: replyOffset === null ? key : (since?.k ?? key),
      l: replyOffset === null ? newest : (since?.l ?? null),
    })
    // A page of a long reply is asked for by offset, so it is always answered,
    // even when nothing in the chat moved since the cursor was handed out.
    if (since && since.k === key && replyOffset === null)
      return { ok: true, value: { ...base, chat: ref, unchanged: true, status, cursor } }

    let shown = messages.slice(-READ_HISTORY_MESSAGES)
    let historyReset = false
    if (since) {
      const at = since.l === null ? -1 : messages.findIndex((m) => m.id === since.l)
      if (since.l !== null && at < 0) historyReset = true
      else shown = messages.slice(at + 1).slice(-READ_HISTORY_MESSAGES)
    }
    const live = this.liveActivityByRoot()
    // A page of a long reply carries no history: the whole budget is the page.
    // A message cut by its own cap is a cut like any other, so the ids of the
    // cut ones travel with the rows and mark the answer that keeps them.
    const capped = new Set<string>()
    const rows = (replyOffset === null ? shown : []).map((m) => {
      const text = cap(m.content, READ_MESSAGE_MAX_CHARS)
      if (text.length < m.content.length) capped.add(m.id)
      return { message_id: m.id, role: m.role, text, at: new Date(m.timestamp).toISOString() }
    })
    return {
      ok: true,
      value: fitChatSnapshot({
        draft: {
          ...base,
          chat: ref,
          title: cap(title, READ_TITLE_MAX_CHARS),
          project: { project_id: project.policy.project_id, label: project.policy.label },
          archived: row.archived === 1,
          status,
          last_activity_at: new Date(this.lastActivity(chatId, row.created_at, live)).toISOString(),
          cursor,
          unchanged: false,
          agent_reply: null,
          pending,
          history: [],
          history_reset: historyReset,
          truncated: false,
          omitted: {
            history: shown.length - rows.length,
            pending: allPending.length - pending.length,
            pull_requests: evidence.pull_requests.omitted,
            checks: evidence.checks.omitted,
          },
          queued_bridge_messages: [],
          call_receipts: [],
          evidence,
        },
        reply: reply && { message_id: reply.id, at: new Date(reply.timestamp).toISOString(), partial: turnRunning },
        replyText: reply?.content ?? '',
        replyOffset,
        rows,
        capped,
      }),
    }
  }

  /** A reader that throws leaves every fact `not_measured`: a read never fails on its evidence. */
  private async readEvidence(chatId: string, observedAt: string): Promise<BridgeEvidence> {
    if (!this.deps.evidence) return emptyBridgeEvidence(observedAt)
    try {
      return await this.deps.evidence(chatId)
    } catch (err) {
      log.warn('building the chat evidence failed', { err: String(err) })
      return emptyBridgeEvidence(observedAt)
    }
  }
}

/**
 * The parts of the evidence a cursor is bound to: the statuses, the counts
 * left out and the facts themselves, without the observation times, which
 * change on every read. A fact a read did not measure is not in it: nothing
 * read it, so nothing can tell that it moved.
 */
function evidenceFingerprint(evidence: BridgeEvidence): unknown {
  const { observed_at: _at, ...code } = evidence.code
  return [
    code,
    evidence.pull_requests.status,
    evidence.pull_requests.omitted,
    evidence.pull_requests.items.map(({ observed_at: _prAt, ...pr }) => pr),
    evidence.checks.status,
    evidence.checks.omitted,
    evidence.checks.items.map(({ observed_at: _checkAt, ...check }) => check),
  ]
}

/**
 * `reply_offset`: where in the latest reply to read from. Absent or null
 * reads the reply's own preview. `invalid` is anything that is not a whole
 * number of characters, 0 or more.
 */
export function parseReplyOffset(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'invalid'
  return value
}

interface FitInput {
  /** The answer without its reply text and its history: both are budgeted below. */
  draft: BridgeChatSnapshot
  reply: { message_id: string; at: string; partial: boolean } | null
  /** The whole reply, however much of it fits. */
  replyText: string
  replyOffset: number | null
  /** The history window, oldest first, each message already capped. */
  rows: BridgeChatSnapshot['history']
  /** The ids in `rows` whose text that cap shortened. */
  capped: Set<string>
}

/**
 * One answer, inside the byte budget. The parts that can be long give way in
 * order: the oldest history messages first, then the reply, which always
 * keeps its head and its tail. Every cut is counted in the answer, so a
 * reader is never shown a part as the whole.
 */
function fitChatSnapshot({ draft, reply, replyText, replyOffset, rows, capped }: FitInput): BridgeChatSnapshot {
  // Everything but the two long parts, with every number as wide as it can
  // become, so the room measured here is never more than what is left.
  const shell = (snapshot: BridgeChatSnapshot): BridgeChatSnapshot => ({
    ...snapshot,
    agent_reply: reply && {
      ...reply,
      text: '',
      length: replyText.length,
      offset: replyText.length,
      truncated: true,
      next_offset: replyText.length,
    },
    history: [],
    truncated: true,
    omitted: { ...snapshot.omitted, history: snapshot.omitted.history + rows.length },
  })
  const roomIn = (snapshot: BridgeChatSnapshot): number =>
    Math.max(READ_CHAT_BUDGET_BYTES - jsonBytes(shell(snapshot)), 0)
  let header = draft
  let room = roomIn(header)
  // Only a pathological chat gets here: the measured facts and the open
  // requests are already capped by count. The reply still has to be readable,
  // so they give way to it rather than crowd it out.
  for (const drop of [dropEvidenceItems, dropPendingItems]) {
    if (room >= READ_REPLY_MIN_BYTES) break
    header = drop(header)
    room = roomIn(header)
  }
  const replyRoom = Math.max(Math.floor(room * 0.6), Math.min(room, READ_REPLY_MIN_BYTES))
  const chunk = replyOffset === null ? previewText(replyText, replyRoom) : windowText(replyText, replyOffset, room)

  let left = room - jsonBytes(chunk.text)
  const kept: BridgeChatSnapshot['history'] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    // One byte for the comma that joins this message to the next.
    const cost = jsonBytes(rows[i]) + 1
    if (cost > left) break
    left -= cost
    kept.unshift(rows[i])
  }
  const omitted = { ...header.omitted, history: header.omitted.history + rows.length - kept.length }
  const answer: BridgeChatSnapshot = {
    ...header,
    agent_reply: reply && {
      ...reply,
      text: chunk.text,
      length: replyText.length,
      offset: chunk.offset,
      truncated: chunk.truncated,
      next_offset: chunk.nextOffset,
    },
    history: kept,
    omitted,
    truncated:
      chunk.truncated || Object.values(omitted).some((n) => n > 0) || kept.some((row) => capped.has(row.message_id)),
  }
  // The arithmetic above holds, but the budget is a promise: never hand back
  // an answer over it because one estimate was a few bytes out. The history
  // gives way first, then the reply itself. A pass that does not make the
  // answer smaller has nothing left to give, so the answer stands as it is:
  // the loop ends on every input, however little room the chat left it.
  let size = jsonBytes(answer)
  while (size > READ_CHAT_BUDGET_BYTES) {
    if (answer.history.length > 0) {
      answer.history = answer.history.slice(1)
      answer.omitted = { ...answer.omitted, history: answer.omitted.history + 1 }
    } else if (answer.agent_reply && answer.agent_reply.text.length > 0) {
      // A few bytes under what the overflow asks for, so the numbers around
      // the text (a wider offset, a longer count) cannot eat the cut again.
      const slack = 16
      const smaller = Math.max(jsonBytes(answer.agent_reply.text) - (size - READ_CHAT_BUDGET_BYTES) - slack, 0)
      const cut = replyOffset === null ? previewText(replyText, smaller) : windowText(replyText, replyOffset, smaller)
      answer.agent_reply = {
        ...answer.agent_reply,
        text: cut.text,
        offset: cut.offset,
        truncated: cut.truncated,
        next_offset: cut.nextOffset,
      }
    } else break
    answer.truncated = true
    const next = jsonBytes(answer)
    if (next >= size) break
    size = next
  }
  return answer
}

/** The measured facts without their items: the statuses and the counts stay. */
function dropEvidenceItems(snapshot: BridgeChatSnapshot): BridgeChatSnapshot {
  const { pull_requests: prs, checks } = snapshot.evidence
  return {
    ...snapshot,
    evidence: {
      ...snapshot.evidence,
      pull_requests: { ...prs, items: [], omitted: prs.omitted + prs.items.length },
      checks: { ...checks, items: [], omitted: checks.omitted + checks.items.length },
    },
    omitted: {
      ...snapshot.omitted,
      pull_requests: snapshot.omitted.pull_requests + prs.items.length,
      checks: snapshot.omitted.checks + checks.items.length,
    },
  }
}

/** The open requests, counted but not listed. The work state still names them. */
function dropPendingItems(snapshot: BridgeChatSnapshot): BridgeChatSnapshot {
  return {
    ...snapshot,
    pending: [],
    omitted: { ...snapshot.omitted, pending: snapshot.omitted.pending + snapshot.pending.length },
  }
}
