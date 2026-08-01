/**
 * Typed client over a WsTransport - the mobile equivalent of the desktop's
 * window.api subset. One instance per paired backend. Channel names and event
 * types come from src/shared, so this stays in lockstep with the server.
 */
import { WsTransport } from '@shared/ws-transport'
import type { Transport } from '@shared/transport'
import { AppChannels, MachineChannels, ProviderChannels, ProviderInstanceChannels, PushChannels } from '@shared/ipc-channels'
import type { RuntimeEvent, RuntimeMode, ProviderKind, ApprovalDecision } from '@shared/provider-events'
import type { ModelOption } from '@shared/models'
import type { Project, ConversationRow, CreateConversationParams, ChatMessage, ProviderInstance, Workspace } from '@shared/types'
import type { SshIapTarget } from '@shared/machines'

export interface StartSessionOpts {
  threadId: string
  provider: ProviderKind
  cwd: string
  model?: string
  runtimeMode?: RuntimeMode
  resumeSessionId?: string
  instanceId?: string
}

/** Subset of the registry's ProviderSession the mobile client reads. */
export interface StartedSession {
  threadId: string
  provider: ProviderKind
  status: string
  cwd: string
  sessionId?: string
}

/**
 * Return shape of AppChannels.LOAD_SESSION_BY_ID (src/main/ipc/app.ts).
 * The handler returns parsed messages plus the conversation row's metadata;
 * `meta` is null when the conversation id is unknown to the backend.
 */
export interface LoadedSession {
  messages: ChatMessage[]
  meta: { id: string; title: string; projectPath: string; agentType: string } | null
  /** Full message count on the backend, which may exceed `messages.length`. */
  total?: number
  /** True when `messages` is only the newest window of the thread. */
  truncated?: boolean
}

export class SwitchboardClient {
  /**
   * Any Transport: WsTransport for a LAN/tunnelled backend, IapTransport for a
   * work VM reached through Google IAP. Everything below is framing-agnostic.
   */
  constructor(readonly transport: Transport) {}

  /** LAN / tunnelled backend over WebSocket. */
  static overWs(url: string, token?: string): SwitchboardClient {
    const dialUrl = token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url
    return new SwitchboardClient(new WsTransport(dialUrl))
  }

  // ── app ──
  getProjects(): Promise<Project[]> {
    return this.transport.invoke(AppChannels.GET_PROJECTS)
  }

  getConversations(projectPath: string): Promise<ConversationRow[]> {
    return this.transport.invoke(AppChannels.GET_CONVERSATIONS, projectPath)
  }

  /** Sidebar workspaces, so the phone groups projects the way the Mac does. */
  listWorkspaces(): Promise<Workspace[]> {
    return this.transport.invoke(AppChannels.WORKSPACE_LIST)
  }

  /** The same settings table the desktop writes, so `projectOrder` matches. */
  getSetting(key: string): Promise<string | null> {
    return this.transport.invoke('settings:get', key)
  }

  setSetting(key: string, value: string): Promise<unknown> {
    return this.transport.invoke('settings:set', key, value)
  }

  /** `limit` returns only the newest N; the result reports `total`/`truncated`. */
  loadSessionById(conversationId: string, limit?: number): Promise<LoadedSession> {
    return this.transport.invoke(AppChannels.LOAD_SESSION_BY_ID, conversationId, { limit })
  }

  createConversation(params: CreateConversationParams): Promise<void> {
    return this.transport.invoke(AppChannels.CREATE_CONVERSATION, params)
  }

  serverVersion(): Promise<string> {
    return this.transport.invoke('server:version')
  }

  /**
   * IAP VMs this backend can see in its ~/.ssh/config, so the user never types
   * project / zone / instance. Only the DESKTOP app registers the machine
   * handlers (the ssh config lives there), so a headless server answers with a
   * no-handler rejection - callers treat any failure as "none discovered".
   */
  listIapTargets(): Promise<SshIapTarget[]> {
    return this.transport.invoke(MachineChannels.LIST_IAP_TARGETS)
  }

  // ── push ──
  /** Register this device so the backend can notify it while the app is closed. */
  registerPush(token: string, label: string, clientRef: string): Promise<{ ok: boolean; error?: string }> {
    return this.transport.invoke(PushChannels.REGISTER, token, label, clientRef)
  }

  /** Which thread this device has open, so it is not notified about it. */
  reportViewing(token: string, threadId: string | null): Promise<unknown> {
    return this.transport.invoke(PushChannels.VIEWING, token, threadId)
  }

  // ── provider ──
  /**
   * Resolves to the live session descriptor; FAILURE IS A REJECTION (the
   * handler throws), never an { ok: false } return - mirror of the desktop
   * contract. Re-invoking for a live threadId re-attaches idempotently.
   */
  startSession(opts: StartSessionOpts): Promise<StartedSession> {
    return this.transport.invoke(ProviderChannels.START_SESSION, opts)
  }

  /** `images` are data URLs with a mimeType, as the desktop composer sends them. */
  sendTurn(
    threadId: string,
    message: string,
    runtimeMode?: RuntimeMode,
    images?: Array<{ url: string; mimeType?: string }>,
    /** Echoed back on the user.message broadcast so we skip our own turn. */
    origin?: string,
  ): Promise<void> {
    return this.transport.invoke(ProviderChannels.SEND_TURN, threadId, message, runtimeMode, images, origin)
  }

  interrupt(threadId: string): Promise<void> {
    return this.transport.invoke(ProviderChannels.INTERRUPT, threadId)
  }

  stopSession(threadId: string): Promise<void> {
    return this.transport.invoke(ProviderChannels.STOP_SESSION, threadId)
  }

  setRuntimeMode(threadId: string, mode: RuntimeMode): Promise<void> {
    return this.transport.invoke(ProviderChannels.SET_RUNTIME_MODE, threadId, mode)
  }

  /**
   * The live session adapter's model list. Thread-bound: the handler resolves
   * the adapter out of the registry's started-session map, so it returns null
   * for an unknown thread or an adapter without `listModels`, and [] while the
   * adapter has no live query yet (Claude only answers once a turn has begun).
   */
  listModels(threadId: string): Promise<ModelOption[] | null> {
    return this.transport.invoke(ProviderChannels.LIST_MODELS, threadId)
  }

  /** Switch the model on a live thread. No-op server-side if the thread is
   *  unknown or the adapter has no setModel. */
  setModel(threadId: string, model: string): Promise<void> {
    return this.transport.invoke(ProviderChannels.SET_MODEL, threadId, model)
  }

  respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.transport.invoke(ProviderChannels.RESPOND_TO_REQUEST, threadId, requestId, decision)
  }

  answerQuestion(threadId: string, requestId: string, answers: string[][]): Promise<void> {
    return this.transport.invoke(ProviderChannels.ANSWER_QUESTION, threadId, requestId, answers)
  }

  // ── provider instances (OAuth profiles / named credential sets) ──
  /**
   * Every instance across all agent types, oldest-first within a type. Callers
   * filter by agentType themselves (mirrors the desktop picker). The wire shape
   * carries env KEY NAMES only - the handler strips values server-side, so no
   * credential ever reaches the phone. Never rejects: the handler logs and
   * returns [] on failure.
   */
  listInstances(): Promise<ProviderInstance[]> {
    return this.transport.invoke(ProviderInstanceChannels.LIST)
  }

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    return this.transport.on(ProviderChannels.EVENT, handler as (...args: unknown[]) => void)
  }

  close(): void {
    // Transport itself has no close(); both concrete transports do.
    ;(this.transport as { close?: () => void }).close?.()
  }
}
