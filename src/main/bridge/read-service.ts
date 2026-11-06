/**
 * The bridge's read side: list_projects, list_recent_chats, search_chats and
 * read_chat over the chats of the projects the owner allowed on this desktop.
 *
 * One typed service. The local MCP wrapper (`mcp/bridge-tools.ts`) calls it
 * for an agent thread; the relay endpoint will call the same methods for the
 * owner. Every read is scoped to the allowlist before any ranking or limit,
 * reads chats under their root id (`resolveRootThreadId`), masks text through
 * the stored-secret paths and never returns a local path.
 *
 * Only this desktop answers for now, so lists are never partial and name no
 * unavailable machine. Evidence is `not_measured` until the measured-check
 * service exists.
 */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  bridgeError,
  publicProjectView,
  type BridgeChatRef,
  type BridgeChatWorkState,
  type BridgeError,
  type BridgeEvidenceStatus,
} from '@shared/bridge'
import { MESSAGE_SEARCH_LIMIT, SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from '@shared/message-search'
import type { PendingBlockingEvent } from '@shared/pending-requests'
import type { ProviderSessionStatus, RuntimeEvent } from '@shared/provider-events'
import type { ChatMessage } from '@shared/types'
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
import { resolveLabel } from './resolve-label'

const log = createMainLogger('bridge:read')

const BRIDGE_LIST_DEFAULT_LIMIT = 20
export const BRIDGE_LIST_MAX_LIMIT = 50
const BRIDGE_SNIPPET_MAX_CHARS = 240
/** Messages a read_chat returns, newest last, and the cap on each one's text. */
const READ_HISTORY_MESSAGES = 20
const READ_MESSAGE_MAX_CHARS = 1000
const READ_REPLY_MAX_CHARS = 4000
const PENDING_SUMMARY_MAX_CHARS = 500
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
  /** The newest stored reply. `partial` while a turn runs: the reply can still change. */
  agent_reply: { message_id: string; text: string; at: string; partial: boolean } | null
  pending: BridgePendingItem[]
  /** Up to 20 messages, oldest first; after `since`, only the newer ones. */
  history: Array<{ message_id: string; role: 'user' | 'assistant'; text: string; at: string }>
  /** True when `since` named a message no longer in the window, so `history` starts over. */
  history_reset: boolean
  queued_bridge_messages: never[]
  call_receipts: never[]
  evidence: { code: BridgeEvidenceStatus; pull_requests: BridgeEvidenceStatus; checks: BridgeEvidenceStatus }
}

export interface BridgeUnchanged extends ResultBase {
  chat: BridgeChatRef
  unchanged: true
  status: BridgeChatWorkState
  cursor: string
}

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: BridgeError }

interface AllowedProject {
  policy: StoredBridgeProjectPolicy
  /** The project paths chats are stored under: the realpath and every known path that resolves to it. */
  paths: string[]
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

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch (err) {
    log.debug('project path does not resolve', { code: (err as NodeJS.ErrnoException).code })
    return null
  }
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

  /** The owner's allowed projects on this desktop, each with the stored paths its chats use. */
  private allowed(machineId: string): AllowedProject[] {
    const policies = listBridgeProjectPolicies().filter((p) => p.machine_id === machineId)
    if (policies.length === 0) return []
    const known = getProjects().map((p) => ({ path: p.path, real: realpathOrNull(p.path) }))
    return policies.map((policy) => ({
      policy,
      paths: [
        ...new Set([
          policy.canonical_local_root,
          ...known.filter((p) => p.real === policy.canonical_local_root).map((p) => p.path),
        ]),
      ],
    }))
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
      title: maskStoredText(chat.id, chat.title),
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
    const savedAgents = (
      getDb()
        .prepare('SELECT DISTINCT agent_type FROM provider_instances WHERE enabled = 1 ORDER BY agent_type')
        .all() as Array<{ agent_type: string }>
    ).map((r) => r.agent_type)
    const projects = this.allowed(machineId).map(({ policy }) => ({
      ...publicProjectView(policy),
      online: true,
      stale: false,
      last_contact_at: base.observed_at,
      agents: policy.allowed_agents.length > 0 ? [...policy.allowed_agents] : savedAgents,
    }))
    return { ok: true, value: { ...base, projects } }
  }

  /** An exact project id, else its label (exact, then fuzzy). */
  private resolveProject(allowed: AllowedProject[], ref: string): BridgeResult<AllowedProject> {
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
    const messageHits = searchMessagesInDatabase(db, input.query, MESSAGE_SEARCH_LIMIT, { projectPaths: paths })
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
  private resolveChat(
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
    const found = resolveLabel(candidates, (row) => row.title, text)
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
  }): Promise<BridgeResult<BridgeChatSnapshot | BridgeUnchanged>> {
    const machineId = this.deps.machineId()
    const allowed = this.allowed(machineId)
    const resolved = this.resolveChat(allowed, machineId, input.chat)
    if (!resolved.ok) return resolved
    const { row, project } = resolved.value
    const chatId = row.id
    const ref: BridgeChatRef = { machine_id: machineId, chat_id: chatId }

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
    const pending = this.deps.live.pending(chatId).map(pendingItem)
    const reply = [...messages].reverse().find((m) => m.role === 'assistant') ?? null
    const newest = messages.at(-1)?.id ?? null
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          status,
          window.total,
          newest,
          reply?.id ?? null,
          reply?.content.length ?? 0,
          pending.map((p) => p.request_id),
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
      k: key,
      l: newest,
    })
    const base = this.base(machineId)
    if (since && since.k === key) return { ok: true, value: { ...base, chat: ref, unchanged: true, status, cursor } }

    let shown = messages.slice(-READ_HISTORY_MESSAGES)
    let historyReset = false
    if (since) {
      const at = since.l === null ? -1 : messages.findIndex((m) => m.id === since.l)
      if (since.l !== null && at < 0) historyReset = true
      else shown = messages.slice(at + 1).slice(-READ_HISTORY_MESSAGES)
    }
    const live = this.liveActivityByRoot()
    return {
      ok: true,
      value: {
        ...base,
        chat: ref,
        title: maskStoredText(chatId, row.title),
        project: { project_id: project.policy.project_id, label: project.policy.label },
        archived: row.archived === 1,
        status,
        last_activity_at: new Date(this.lastActivity(chatId, row.created_at, live)).toISOString(),
        cursor,
        unchanged: false,
        agent_reply: reply
          ? {
              message_id: reply.id,
              text: cap(reply.content, READ_REPLY_MAX_CHARS),
              at: new Date(reply.timestamp).toISOString(),
              partial: turnRunning,
            }
          : null,
        pending,
        history: shown.map((m) => ({
          message_id: m.id,
          role: m.role,
          text: cap(m.content, READ_MESSAGE_MAX_CHARS),
          at: new Date(m.timestamp).toISOString(),
        })),
        history_reset: historyReset,
        queued_bridge_messages: [],
        call_receipts: [],
        evidence: { code: 'not_measured', pull_requests: 'not_measured', checks: 'not_measured' },
      },
    }
  }
}
