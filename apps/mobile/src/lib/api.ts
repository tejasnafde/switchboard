/**
 * Typed client over a WsTransport - the mobile equivalent of the desktop's
 * window.api subset. One instance per paired backend. Channel names and event
 * types come from src/shared, so this stays in lockstep with the server.
 */
import { WsTransport } from '@shared/ws-transport'
import type { Transport } from '@shared/transport'
import { AppChannels, ProviderChannels } from '@shared/ipc-channels'
import type { RuntimeEvent, RuntimeMode, ProviderKind, ApprovalDecision } from '@shared/provider-events'
import type { Project, ConversationRow, CreateConversationParams, ChatMessage } from '@shared/types'

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

  loadSessionById(conversationId: string): Promise<LoadedSession> {
    return this.transport.invoke(AppChannels.LOAD_SESSION_BY_ID, conversationId)
  }

  createConversation(params: CreateConversationParams): Promise<void> {
    return this.transport.invoke(AppChannels.CREATE_CONVERSATION, params)
  }

  serverVersion(): Promise<string> {
    return this.transport.invoke('server:version')
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

  sendTurn(threadId: string, message: string, runtimeMode?: RuntimeMode): Promise<void> {
    return this.transport.invoke(ProviderChannels.SEND_TURN, threadId, message, runtimeMode)
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

  respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.transport.invoke(ProviderChannels.RESPOND_TO_REQUEST, threadId, requestId, decision)
  }

  answerQuestion(threadId: string, requestId: string, answers: string[][]): Promise<void> {
    return this.transport.invoke(ProviderChannels.ANSWER_QUESTION, threadId, requestId, answers)
  }

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    return this.transport.on(ProviderChannels.EVENT, handler as (...args: unknown[]) => void)
  }

  close(): void {
    // Transport itself has no close(); both concrete transports do.
    ;(this.transport as { close?: () => void }).close?.()
  }
}
