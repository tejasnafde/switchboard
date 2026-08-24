/**
 * Typed client over a WsTransport - the mobile equivalent of the desktop's
 * window.api subset. One instance per paired backend. Channel names and event
 * types come from src/shared, so this stays in lockstep with the server.
 */
import { WsTransport } from '@shared/ws-transport'
import type { Transport } from '@shared/transport'
import { AppChannels, MachineChannels, ProviderChannels, ProviderInstanceChannels, PushChannels, SttChannels, WorktreeCreationChannels } from '@shared/ipc-channels'
import type { SttTranscribeRequest, SttTranscribeResult } from '@shared/stt'
import type {
  RuntimeEvent,
  RuntimeMode,
  ProviderKind,
  ApprovalDecision,
  ProviderInstanceSwitchRequest,
  ProviderInstanceSwitchResult,
  UserTurnSubmissionV1,
  UserTurnSubmissionResult,
  UserTurnResolutionV1,
  UserTurnResolutionResult,
} from '@shared/provider-events'
import type { ModelOption } from '@shared/models'
import type { Project, ConversationRow, CreateConversationParams, ChatMessage, ProviderInstance, ProviderSkill, Workspace } from '@shared/types'
import type { SshIapTarget } from '@shared/machines'
import type {
  ForkConversationOutcome,
  ForkConversationRequest,
  ForkLineageMetadata,
} from '@shared/conversation-fork'
import type {
  GetWorktreeCreationRequest,
  WorktreeCreationActionRequest,
  WorktreeCreationProgressEvent,
  WorktreeCreationRequest,
  WorktreeCreationSnapshot,
} from '@shared/worktree-creation'
import {
  SETTING_DEFAULT_INSTANCE_ID,
  defaultModelSettingKey,
  SETTING_DEFAULT_RUNTIME_MODE,
  type SessionDefaults,
} from '@shared/session-defaults'

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
  meta: {
    id: string
    title: string
    projectPath: string
    agentType: string
    worktreePath?: string | null
    worktreeBranch?: string | null
    worktreeId?: string | null
    providerInstanceId?: string | null
    runtimeMode?: RuntimeMode | null
    model?: string | null
    reasoningEffort?: 'low' | 'medium' | 'high' | null
    forkMetadata?: ForkLineageMetadata | null
  } | null
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

  supportsCapability(capability: string): boolean | undefined {
    return this.transport.supportsCapability?.(capability)
  }

  /**
   * LAN / tunnelled backend over WebSocket.
   *
   * Two credential paths. `auth` is the current one: the token travels in a
   * frame after the socket opens, never in the URL, and identifies one device
   * that can be revoked on its own. `token` is the legacy shared secret in the
   * query string, kept so a phone paired before this change keeps working
   * until it re-pairs.
   */
  static overWs(
    url: string,
    token?: string,
    auth?: { session?: string; pairing?: string; label?: string } | null,
  ): SwitchboardClient {
    // `auth=frame` tells the backend to expect in-band credentials rather than
    // rejecting a tokenless connection outright. It carries no secret.
    const query = auth ? 'auth=frame' : token ? `token=${encodeURIComponent(token)}` : ''
    const dialUrl = query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url
    return new SwitchboardClient(new WsTransport(dialUrl, undefined, {}, auth ?? null))
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

  /** Shared backend settings used by theme and provider preferences. */
  getSetting(key: string): Promise<string | null> {
    return this.transport.invoke('settings:get', key)
  }

  setSetting(key: string, value: string): Promise<unknown> {
    return this.transport.invoke('settings:set', key, value)
  }

  /**
   * The machine's default mode / model / profile, so a session started here
   * opens the way the desktop has it rather than on the phone's own guesses.
   * Missing keys are normal on a backend nobody has configured; the caller
   * keeps its own fallbacks for those.
   */
  async getSessionDefaults(agentType: string): Promise<SessionDefaults> {
    const [runtimeMode, model, instanceId] = await Promise.all([
      this.getSetting(SETTING_DEFAULT_RUNTIME_MODE),
      this.getSetting(defaultModelSettingKey(agentType)),
      this.getSetting(SETTING_DEFAULT_INSTANCE_ID),
    ])
    return {
      runtimeMode: runtimeMode ?? undefined,
      model: model ?? undefined,
      instanceId: instanceId ?? undefined,
    }
  }

  /** `limit` returns only the newest N; the result reports `total`/`truncated`. */
  loadSessionById(conversationId: string, limit?: number): Promise<LoadedSession> {
    return this.transport.invoke(AppChannels.LOAD_SESSION_BY_ID, conversationId, { limit })
  }

  forkConversation(request: ForkConversationRequest): Promise<ForkConversationOutcome> {
    return this.transport.invoke(AppChannels.FORK_CONVERSATION, request)
  }

  getConversationFork(request: {
    requestId: string
    sourceConversationId: string
    machineId?: string
  }): Promise<ForkConversationOutcome | null> {
    return this.transport.invoke(AppChannels.GET_CONVERSATION_FORK, request)
  }

  renameConversation(conversationId: string, title: string): Promise<unknown> {
    return this.transport.invoke(AppChannels.RENAME_CONVERSATION, conversationId, title)
  }

  createConversation(params: CreateConversationParams): Promise<void> {
    return this.transport.invoke(AppChannels.CREATE_CONVERSATION, params)
  }

  createWorktreeCreation(request: WorktreeCreationRequest): Promise<WorktreeCreationSnapshot> {
    return this.transport.invoke(WorktreeCreationChannels.CREATE, request)
  }

  getWorktreeCreation(request: GetWorktreeCreationRequest): Promise<WorktreeCreationSnapshot> {
    return this.transport.invoke(WorktreeCreationChannels.GET, request)
  }

  actOnWorktreeCreation(request: WorktreeCreationActionRequest): Promise<WorktreeCreationSnapshot> {
    return this.transport.invoke(WorktreeCreationChannels.ACT, request)
  }

  onWorktreeCreationProgress(handler: (event: WorktreeCreationProgressEvent) => void): () => void {
    return this.transport.on(WorktreeCreationChannels.PROGRESS, handler)
  }

  /** Persist the read point and broadcast it, so the Mac's badge clears too. */
  markRead(threadId: string): Promise<{ ok: boolean; at: number }> {
    return this.transport.invoke(AppChannels.MARK_READ, threadId)
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

  // ── speech-to-text ──
  /**
   * Backend whisper.cpp correction of a dictation recording. Never rejects on
   * a transcription problem - the handler answers { ok: false } so the caller
   * keeps the on-device text. The FIRST call on a fresh backend can take
   * minutes (model download + load), so callers bound their own wait.
   */
  transcribe(req: SttTranscribeRequest): Promise<SttTranscribeResult> {
    return this.transport.invoke(SttChannels.TRANSCRIBE, req)
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
  ): Promise<UserTurnSubmissionResult | undefined> {
    return this.transport.invoke(ProviderChannels.SEND_TURN, threadId, message, runtimeMode, images, origin)
  }

  /**
   * Atomically submits the complete user turn on backends that expose the
   * envelope contract. A missing handler identifies an older paired backend,
   * where the positional call is the only compatible path. Transport errors
   * are never downgraded because the first invocation may have committed.
   */
  async submitTurn(envelope: UserTurnSubmissionV1): Promise<UserTurnSubmissionResult | undefined> {
    try {
      return await this.transport.invoke(ProviderChannels.SUBMIT_USER_TURN, envelope)
    } catch (error) {
      if (!(error instanceof Error) || !/^no handler: provider:submit-user-turn$/i.test(error.message)) {
        throw error
      }
      return this.sendTurn(
        envelope.threadId,
        envelope.providerText,
        envelope.runtimeMode,
        envelope.images,
        envelope.origin,
      )
    }
  }

  resolveTurn(resolution: UserTurnResolutionV1): Promise<UserTurnResolutionResult> {
    return this.transport.invoke(ProviderChannels.RESOLVE_USER_TURN, resolution)
  }

  /** Skills the live agent reports. Empty until its session is up. */
  listSkills(threadId: string): Promise<ProviderSkill[] | null> {
    return this.transport.invoke(ProviderChannels.LIST_SKILLS, threadId)
  }

  interrupt(threadId: string): Promise<void> {
    return this.transport.invoke(ProviderChannels.INTERRUPT, threadId)
  }

  stopSession(threadId: string): Promise<void> {
    return this.transport.invoke(ProviderChannels.STOP_SESSION, threadId)
  }

  switchInstance(threadId: string, input: ProviderInstanceSwitchRequest): Promise<ProviderInstanceSwitchResult> {
    return this.transport.invoke(ProviderChannels.SWITCH_INSTANCE, threadId, input)
  }

  getPendingHandoff(threadId: string): Promise<{ from: string | null }> {
    return this.transport.invoke(AppChannels.GET_CONVERSATION_PENDING_HANDOFF, threadId)
  }

  setPendingHandoff(threadId: string, from: string | null): Promise<{ ok: boolean }> {
    return this.transport.invoke(AppChannels.SET_CONVERSATION_PENDING_HANDOFF, threadId, from)
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
