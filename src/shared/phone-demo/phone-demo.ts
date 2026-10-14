/**
 * The phones' demo mode: a backend that lives inside the app, so a store
 * reviewer (or anyone without a desktop) can tap through every main screen.
 *
 * `fixture/phone-demo.json` holds everything the demo shows: one project, three
 * chats, sample pull requests, and the scripts that play events on a timer.
 * Both phones read that one file (the Expo app imports it, native Android
 * packs it as an asset and plays it with `PhoneDemoRpc.kt`), so they show the
 * same demo. `DemoTransport` answers the same channels a real backend does,
 * which is why the real screens render it unchanged. It holds no socket, no
 * timer outside its scripts and nothing on disk.
 *
 * Fixture conventions, shared with the Kotlin player:
 * - A string `@now`, `@now-60000` or `@now+5000` is a time in ms relative to
 *   when the demo starts (`materialize`).
 * - A script is a list of `{ atMs, event }`, played from the moment it starts.
 *   Starting a script on a thread cancels what is left of the one before.
 * - In a script, `@thread` is the chat the script plays in and `@message` is a
 *   fresh message id per play.
 * - A chat's own script overrides the global one of the same name.
 */
import raw from './fixture/phone-demo.json'
import {
  AppChannels,
  ProviderChannels,
  ProviderInstanceChannels,
  PullRequestChannels,
  PushChannels,
} from '../ipc-channels'
import type { Transport } from '../transport'
import {
  REQUEST_EXPIRED,
  type ApprovalDecision,
  type ProviderSessionStatus,
  type RuntimeEvent,
  type RuntimeRequestOpenedEvent,
  type UserTurnSubmissionV1,
} from '../provider-events'
import type { ChatMessage, ConversationRow, Project } from '../types'
import type { PrDetail, PrListData, PrRef, PrResult, PrSummary } from '../pull-requests'
import type { PrLinkChat } from '../pull-request-links'
import { createLogger } from '../logger'

const log = createLogger('phone-demo')

export const DEMO_CONNECTION_ID = 'demo'
/** The demo machine's name wherever a machine is named. */
export const DEMO_LABEL = raw.connection.label
/** The demo's one project, which the demo opens straight into. */
export const DEMO_PROJECT: { path: string; name: string } = raw.project

export function isDemoConnection(connectionId: string | null | undefined): boolean {
  return connectionId === DEMO_CONNECTION_ID
}

/** A map keyed by connection id or by `<connectionId>:<threadId>`, without the demo's entries. */
export function withoutDemo<T>(byKey: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(byKey).filter(([key]) => key !== DEMO_CONNECTION_ID && !key.startsWith(`${DEMO_CONNECTION_ID}:`)),
  )
}

/** What a demo screen says when the user reaches for something it cannot do. */
export const NOT_IN_DEMO = 'Not in the demo. Pair a machine to use this.'

export type DemoScriptName = 'connect' | 'approve' | 'deny' | 'interrupt' | 'reply'

export interface DemoStep {
  atMs: number
  event: RuntimeEvent
}

export interface DemoChat {
  id: string
  title: string
  agentType: string
  branch: string
  updatedAt: number
  statusLine: string
  messages: ChatMessage[]
  pending: RuntimeRequestOpenedEvent[]
  scripts: Partial<Record<DemoScriptName, DemoStep[]>>
}

export type DemoPullRequest = PrSummary & { detail: Omit<PrDetail, keyof PrSummary> }

export interface DemoData {
  version: number
  connection: { id: string; label: string }
  project: { path: string; name: string }
  chats: DemoChat[]
  scripts: Partial<Record<DemoScriptName, DemoStep[]>>
  pullRequests: DemoPullRequest[]
}

const NOW_TOKEN = /^@now([+-]\d+)?$/

/** Replace every `@now` token with a real time, anchored at `now`. */
export function materialize(value: unknown, now: number): unknown {
  if (typeof value === 'string') {
    const match = NOW_TOKEN.exec(value)
    return match ? now + Number(match[1] ?? 0) : value
  }
  if (Array.isArray(value)) return value.map((item) => materialize(item, now))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item, now)]))
  }
  return value
}

export function loadDemoData(now: number = Date.now()): DemoData {
  return materialize(raw, now) as DemoData
}

/** A chat's script, or the global one, with `@thread` and `@message` filled in. */
export function scriptFor(data: DemoData, chatId: string, name: DemoScriptName, messageId: string): DemoStep[] {
  const chat = data.chats.find((c) => c.id === chatId)
  const steps = chat?.scripts[name] ?? data.scripts[name] ?? []
  return steps.map((step) => ({
    atMs: step.atMs,
    event: JSON.parse(
      JSON.stringify(step.event)
        .replaceAll('"@thread"', JSON.stringify(chatId))
        .replaceAll('"@message"', JSON.stringify(messageId)),
    ) as RuntimeEvent,
  }))
}

export function demoProjects(data: DemoData): Project[] {
  return [
    {
      path: data.project.path,
      name: data.project.name,
      workspaceId: null,
      sessions: data.chats.map((chat) => ({
        id: chat.id,
        source: 'claude-code',
        title: chat.title,
        startedAt: chat.messages[0]?.timestamp ?? chat.updatedAt,
        messageCount: chat.messages.length,
        filePath: '',
        worktreeBranch: chat.branch,
        agentType: chat.agentType,
        statusLine: chat.statusLine,
      })),
    },
  ]
}

export function demoConversations(data: DemoData, projectPath: string): ConversationRow[] {
  if (projectPath !== data.project.path) return []
  return data.chats.map((chat) => ({
    id: chat.id,
    project_path: data.project.path,
    agent_type: chat.agentType,
    session_id: null,
    title: chat.title,
    created_at: chat.messages[0]?.timestamp ?? chat.updatedAt,
    updated_at: chat.updatedAt,
    worktree_branch: chat.branch,
    status_line: chat.statusLine,
  }))
}

function demoSummary({ detail: _detail, ...summary }: DemoPullRequest): PrSummary {
  return summary
}

function findPullRequest(data: DemoData, ref: PrRef): DemoPullRequest | undefined {
  return data.pullRequests.find(
    (pr) =>
      pr.ref.number === ref.number &&
      pr.ref.owner === ref.owner &&
      pr.ref.name === ref.name &&
      pr.ref.host === ref.host,
  )
}

export function demoPullRequestList(data: DemoData, now: number): PrResult<PrListData> {
  const first = data.pullRequests[0]
  return {
    ok: true,
    data: {
      prs: data.pullRequests.map(demoSummary),
      sources: first
        ? [
            {
              repo: { host: first.ref.host, owner: first.ref.owner, name: first.ref.name },
              projectPaths: [data.project.path],
              error: null,
            },
          ]
        : [],
      unsupportedProjects: [],
      fetchedAt: now,
      hidden: [],
    },
  }
}

/** Capabilities the demo backend claims. Anything else reads as an older backend. */
const DEMO_CAPABILITIES: ReadonlySet<string> = new Set(['pending_requests_v1'])

type Handler = (...args: unknown[]) => void

/**
 * A `Transport` that answers from the fixture and plays its scripts. Scripts
 * start when the first listener subscribes to provider events, so nothing is
 * emitted before the app is listening.
 */
export class DemoTransport implements Transport {
  readonly data: DemoData
  private readonly listeners = new Map<string, Set<Handler>>()
  private readonly timers = new Map<string, Array<ReturnType<typeof setTimeout>>>()
  private readonly status = new Map<string, ProviderSessionStatus>()
  private readonly pending = new Map<string, RuntimeRequestOpenedEvent[]>()
  private started = false
  private closed = false
  private plays = 0

  constructor(private readonly now: () => number = Date.now) {
    this.data = loadDemoData(now())
    for (const chat of this.data.chats) this.pending.set(chat.id, [...chat.pending])
  }

  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    try {
      return Promise.resolve(this.answer(channel, args) as T)
    } catch (err) {
      return Promise.reject(err)
    }
  }

  send(channel: string): void {
    log.debug('ignored a send in the demo', channel)
  }

  on<A extends unknown[] = unknown[]>(channel: string, handler: (...args: A) => void): () => void {
    const set = this.listeners.get(channel) ?? new Set<Handler>()
    set.add(handler as Handler)
    this.listeners.set(channel, set)
    if (channel === ProviderChannels.EVENT && !this.started && !this.closed) {
      this.started = true
      for (const chat of this.data.chats) this.play(chat.id, 'connect')
    }
    return () => set.delete(handler as Handler)
  }

  isAlive(): boolean {
    return !this.closed
  }

  isConnected(): boolean {
    return !this.closed
  }

  supportsCapability(capability: string): boolean {
    return DEMO_CAPABILITIES.has(capability)
  }

  close(): void {
    this.closed = true
    for (const handles of this.timers.values()) handles.forEach(clearTimeout)
    this.timers.clear()
    this.listeners.clear()
  }

  /** A thread's status as the demo backend sees it. */
  statusOf(threadId: string): ProviderSessionStatus {
    return this.status.get(threadId) ?? 'idle'
  }

  private play(threadId: string, name: DemoScriptName): void {
    this.timers.get(threadId)?.forEach(clearTimeout)
    const steps = scriptFor(this.data, threadId, name, `demo-${name}-${++this.plays}`)
    this.timers.set(
      threadId,
      steps.map((step) => setTimeout(() => this.emit(step.event), step.atMs)),
    )
  }

  private emit(event: RuntimeEvent): void {
    if (this.closed) return
    if (event.type === 'status') this.status.set(event.threadId, event.status)
    if (event.type === 'request.closed') {
      this.pending.set(
        event.threadId,
        (this.pending.get(event.threadId) ?? []).filter((p) => p.requestId !== event.requestId),
      )
    }
    this.listeners.get(ProviderChannels.EVENT)?.forEach((handler) => handler(event))
  }

  private chat(threadId: unknown): DemoChat {
    const chat = this.data.chats.find((c) => c.id === threadId)
    if (!chat) throw new Error(NOT_IN_DEMO)
    return chat
  }

  /** The user's message echoes back at once, then the scripted reply plays. */
  private acceptTurn(threadId: string, text: string, origin: string | undefined, displayBody?: string): void {
    this.chat(threadId)
    this.emit({ type: 'user.message', threadId, text, displayBody, origin, at: this.now() })
    this.play(threadId, 'reply')
  }

  private answer(channel: string, args: unknown[]): unknown {
    if (this.closed) throw new Error('The demo has ended')
    const data = this.data
    switch (channel) {
      case 'server:version':
        return 'demo'
      case AppChannels.GET_PROJECTS:
        return demoProjects(data)
      case AppChannels.WORKSPACE_LIST:
      case ProviderChannels.LIST_QUEUED_TURNS:
      case ProviderChannels.LIST_SKILLS:
      case ProviderChannels.LIST_CATALOG:
      case ProviderInstanceChannels.LIST:
      case PullRequestChannels.LINKS:
      case PullRequestChannels.LINKABLE_CHATS:
        return []
      case AppChannels.GET_CONVERSATIONS:
        return demoConversations(data, String(args[0]))
      case AppChannels.LOAD_SESSION_BY_ID: {
        const chat = data.chats.find((c) => c.id === args[0])
        if (!chat) return { messages: [], meta: null }
        return {
          messages: chat.messages,
          total: chat.messages.length,
          meta: {
            id: chat.id,
            title: chat.title,
            projectPath: data.project.path,
            agentType: chat.agentType,
            worktreeBranch: chat.branch,
          },
        }
      }
      case AppChannels.MARK_READ:
        return { ok: true, at: this.now() }
      case AppChannels.GET_CONVERSATION_PENDING_HANDOFF:
        return { from: null }
      case AppChannels.SET_CONVERSATION_PENDING_HANDOFF:
        return { ok: true }
      case 'settings:get':
      case ProviderChannels.LIST_MODELS:
        return null
      // The pickers keep their choice on the phone; nothing runs to apply it to.
      case ProviderChannels.SET_RUNTIME_MODE:
      case ProviderChannels.SET_MODEL:
      case ProviderChannels.STOP_SESSION:
        return undefined
      case PushChannels.VIEWING:
        return { ok: true }
      case ProviderChannels.START_SESSION: {
        const opts = args[0] as { threadId?: string; cwd?: string }
        const chat = this.chat(opts?.threadId)
        return { threadId: chat.id, provider: 'claude', status: this.statusOf(chat.id), cwd: data.project.path }
      }
      case ProviderChannels.GET_PENDING_REQUESTS:
        return this.pending.get(String(args[0])) ?? []
      case ProviderChannels.SUBMIT_USER_TURN: {
        const envelope = args[0] as UserTurnSubmissionV1
        this.acceptTurn(envelope.threadId, envelope.providerText, envelope.origin, envelope.displayBody)
        return { status: 'accepted', accepted: true, duplicate: false, state: 'completed', acceptedAt: this.now() }
      }
      case ProviderChannels.SEND_TURN:
        this.acceptTurn(String(args[0]), String(args[1]), typeof args[4] === 'string' ? args[4] : undefined)
        return undefined
      case ProviderChannels.RESPOND_TO_REQUEST: {
        const threadId = String(args[0])
        const decision = args[2] as ApprovalDecision
        if (!(this.pending.get(threadId) ?? []).some((p) => p.requestId === args[1])) throw new Error(REQUEST_EXPIRED)
        this.play(threadId, decision === 'approve' ? 'approve' : 'deny')
        return undefined
      }
      case ProviderChannels.INTERRUPT: {
        const threadId = String(args[0])
        const live = this.statusOf(threadId) === 'running'
        if (live) this.play(threadId, 'interrupt')
        return { live }
      }
      case PullRequestChannels.LIST:
        return demoPullRequestList(data, this.now())
      case PullRequestChannels.DETAIL: {
        const pr = findPullRequest(data, args[0] as PrRef)
        if (!pr) throw new Error(NOT_IN_DEMO)
        const { detail, ...summary } = pr
        return { ok: true, data: { ...summary, ...detail } } satisfies PrResult<PrDetail>
      }
      case PullRequestChannels.LINKED_CHATS: {
        const pr = findPullRequest(data, args[0] as PrRef)
        return data.chats
          .filter((chat) => pr && chat.branch === pr.sourceBranch)
          .map((chat): PrLinkChat => ({
            id: chat.id,
            familyIds: [chat.id],
            title: chat.title,
            agentType: chat.agentType,
            projectPath: data.project.path,
            updatedAt: chat.updatedAt,
            linkSource: 'auto',
          }))
      }
      default:
        log.debug('channel not in the demo', channel)
        throw new Error(NOT_IN_DEMO)
    }
  }
}
