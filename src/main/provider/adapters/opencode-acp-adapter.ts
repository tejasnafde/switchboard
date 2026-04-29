/**
 * OpenCode ACP adapter — speaks the Agent Client Protocol (Zed-led
 * standard) to a long-lived `opencode acp` child over JSON-RPC on stdio.
 *
 * Replaces the legacy shell-out adapter (`opencode-adapter.ts`), which
 * spawned `opencode run --format json` per turn with a 10–30s cold-boot.
 * The ACP child boots once per session, after which:
 *   - `session/prompt` returns first chunk in <1s
 *   - tool calls / reasoning / plans / token usage / cost stream live
 *   - permissions surface as a real `requestPermission` RPC
 *   - `available_commands_update` pushes the skill list (was a side
 *     `opencode debug skill` shell-out)
 *   - the model catalog arrives inline on `session/new` (was a side
 *     `opencode models` shell-out)
 *
 * Selection between this adapter and the legacy one is gated by the
 * `opencode.useAcpAdapter` setting (default `true`); see
 * `provider-registry.ts`.
 *
 * Wire layer: uses the official `@agentclientprotocol/sdk` package, the
 * same one OpenCode itself depends on. We get `ClientSideConnection`
 * (RPC + notifications + types) and `ndJsonStream` (line framing) for
 * free. Node's Readable/Writable.toWeb() bridges child stdio into the
 * SDK's WhatWG-stream API.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { Readable, Writable } from 'stream'
import { promises as fs } from 'fs'
import {
  ClientSideConnection,
  ndJsonStream,
  RequestError,
  type Agent,
  type Client,
  type SessionNotification,
  type SessionUpdate,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type NewSessionResponse,
  type ModelInfo,
  type AvailableCommand,
} from '@agentclientprotocol/sdk'
import { createMainLogger as createLogger } from '../../logger'
import type {
  ProviderAdapter,
  ProviderSession,
  SessionStartOpts,
  RuntimeEvent,
  RuntimeMode,
  ApprovalDecision,
} from '../types'
import type { ProviderSkill } from '@shared/types'
import { decidePermission, denialMessage } from '../policy'
import { findOpencodePath, buildOpencodeEnv } from './opencode/env'

const log = createLogger('provider:opencode-acp')
const LOG_PAYLOAD_LIMIT = 4000

function truncate(v: string): string {
  return v.length > LOG_PAYLOAD_LIMIT
    ? `${v.slice(0, LOG_PAYLOAD_LIMIT)}…<truncated>`
    : v
}

/**
 * Switchboard runtime mode → ACP mode.
 *
 * OpenCode ships only `build` and `plan`. The finer-grained modes
 * (`sandbox` / `accept-edits` / `full-access`) become local permission
 * policy on top of `requestPermission`; the agent-side mode stays
 * `build` and we let `decidePermission()` gate individual tools.
 */
function runtimeModeToAcp(mode: RuntimeMode): string {
  return mode === 'plan' ? 'plan' : 'build'
}

interface PendingPermission {
  /** Resolves the requestPermission RPC the agent is awaiting. */
  resolve: (outcome: RequestPermissionResponse) => void
  /** Original tool name (used by respondToRequest to log denial). */
  toolName: string
  /** Maps decision → optionId for the agent. */
  allowOptionId: string | null
  rejectOptionId: string | null
}

interface ActiveSession {
  session: ProviderSession
  onEvent: (event: RuntimeEvent) => void
  child: ChildProcessWithoutNullStreams | null
  connection: ClientSideConnection | null
  /** ACP session id returned by `session/new`. */
  sessionId: string | null
  /** Pending `requestPermission` calls awaiting user decision. */
  pendingPermissions: Map<string, PendingPermission>
  /** Cached skill list, kept fresh by `available_commands_update`. */
  skills: ProviderSkill[]
  /** Catalog from `session/new`'s `models.availableModels`. */
  availableModels: ModelInfo[]
  /** In-flight prompt promise (so we know a turn is active). */
  inFlightPrompt: Promise<void> | null
  /** Wall-clock turn-start timestamp; null when no turn is in flight. */
  turnStartedAt: number | null
}

/**
 * Map an ACP `SessionUpdate` into zero or more Switchboard `RuntimeEvent`s.
 *
 * Pure / exported so the unit tests don't need a live `opencode acp`.
 * The adapter's `Client.sessionUpdate` handler consumes the result.
 */
export function mapSessionUpdate(
  threadId: string,
  notification: SessionNotification,
): RuntimeEvent[] {
  const update = notification.update
  const events: RuntimeEvent[] = []

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const text = textFromContent(update.content)
      if (!text) break
      const messageId = update.messageId
        ?? `acp_msg_${update.sessionUpdate}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      events.push({
        type: 'content',
        threadId,
        messageId,
        text,
        streamKind: update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant',
      })
      break
    }

    case 'tool_call': {
      events.push({
        type: 'tool.started',
        threadId,
        toolId: update.toolCallId,
        toolName: update.title || update.kind || 'tool',
        input: update.rawInput ?? null,
      })
      break
    }

    case 'tool_call_update': {
      // Only emit `tool.completed` on terminal status. Intermediate status
      // (`pending` / `in_progress`) keeps the user-visible state inside the
      // already-emitted `tool.started` card.
      if (update.status === 'completed' || update.status === 'failed') {
        const output = stringifyOutput(update)
        events.push({
          type: 'tool.completed',
          threadId,
          toolId: update.toolCallId,
          ...(output ? { output } : {}),
        })
      }
      break
    }

    case 'plan': {
      const planMarkdown = update.entries
        .map((e) => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`)
        .join('\n')
      events.push({
        type: 'plan.proposed',
        threadId,
        planId: `acp_plan_${Date.now()}`,
        planMarkdown,
      })
      break
    }

    case 'usage_update': {
      events.push({
        type: 'context_window',
        threadId,
        usedTokens: update.used,
        maxTokens: update.size,
        ...(update.cost?.amount !== undefined ? { costUsd: update.cost.amount } : {}),
      })
      break
    }

    case 'available_commands_update':
      // No RuntimeEvent for skill changes — adapter caches and the renderer
      // re-fetches via listSkills(). Returning [] signals "consumed".
      break

    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'user_message_chunk':
      // History replay during loadSession + state-only updates we don't yet
      // surface to the renderer. Quietly consumed.
      break

    default:
      // Forward as-is into the log so we notice new wire types.
      log.debug(`unhandled sessionUpdate: ${(update as { sessionUpdate?: string }).sessionUpdate ?? 'unknown'}`)
  }

  return events
}

/** Pluck the displayable text out of an ACP ContentBlock. */
function textFromContent(content: ContentBlock): string {
  if (content.type === 'text') return content.text ?? ''
  if (content.type === 'resource') {
    const r = content.resource as { text?: string } | undefined
    return r?.text ?? ''
  }
  return ''
}

/** Convert tool-call output blocks into a single string for the UI. */
function stringifyOutput(update: SessionUpdate & { sessionUpdate: 'tool_call_update' }): string | null {
  if (typeof update.rawOutput === 'string') return update.rawOutput
  if (update.content && update.content.length > 0) {
    const parts: string[] = []
    for (const block of update.content) {
      if (block.type === 'content' && block.content.type === 'text') {
        parts.push(block.content.text)
      } else if (block.type === 'diff') {
        parts.push(block.newText ?? '')
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    try {
      return JSON.stringify(update.rawOutput, null, 2)
    } catch {
      return String(update.rawOutput)
    }
  }
  return null
}

/**
 * Convert OpenCode's `available_commands_update` payload into Switchboard
 * skills. Exported pure for unit tests.
 */
export function mapAvailableCommands(commands: AvailableCommand[]): ProviderSkill[] {
  const out: ProviderSkill[] = []
  const seen = new Set<string>()
  for (const cmd of commands) {
    const name = cmd.name?.replace(/^\$/, '').replace(/^\//, '').trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({
      name,
      ...(cmd.description ? { description: cmd.description } : {}),
      source: 'opencode',
    })
  }
  return out
}

/**
 * Pick the allow/reject option ids out of an ACP permission request.
 * ACP describes options via `kind` ("allow_once" | "allow_always" |
 * "reject_once") so the client can render labels itself.
 */
export function pickPermissionOptions(
  options: RequestPermissionRequest['options'],
): { allow: string | null; reject: string | null } {
  let allow: string | null = null
  let reject: string | null = null
  for (const o of options) {
    if (!allow && (o.kind === 'allow_once' || o.kind === 'allow_always')) {
      allow = o.optionId
    }
    if (!reject && o.kind === 'reject_once') {
      reject = o.optionId
    }
  }
  // Fall back to first/last when kinds aren't tagged as expected.
  if (!allow && options.length > 0) allow = options[0].optionId
  if (!reject && options.length > 1) reject = options[options.length - 1].optionId
  return { allow, reject }
}

/** Derive a stable tool name string from the agent's permission request. */
function toolNameFromPermission(req: RequestPermissionRequest): string {
  const tc = req.toolCall as { title?: string; kind?: string } | undefined
  return tc?.title || tc?.kind || 'tool'
}

export class OpencodeAcpAdapter implements ProviderAdapter {
  readonly provider = 'opencode' as const
  private sessions = new Map<string, ActiveSession>()

  async isAvailable(): Promise<boolean> {
    return findOpencodePath() !== null
  }

  async startSession(
    opts: SessionStartOpts,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<ProviderSession> {
    const binPath = findOpencodePath()
    if (!binPath) {
      throw new Error('OpenCode not found. Install: curl -fsSL https://opencode.ai/install | bash')
    }

    const session: ProviderSession = {
      threadId: opts.threadId,
      provider: 'opencode',
      status: 'connecting',
      model: opts.model,
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: Date.now(),
    }

    const active: ActiveSession = {
      session,
      onEvent,
      child: null,
      connection: null,
      sessionId: null,
      pendingPermissions: new Map(),
      skills: [],
      availableModels: [],
      inFlightPrompt: null,
      turnStartedAt: null,
    }
    this.sessions.set(opts.threadId, active)

    onEvent({ type: 'status', threadId: opts.threadId, status: 'connecting' })

    // OPENCODE_ENABLE_QUESTION_TOOL=1 enables the AskUserQuestion-style tool
    // for ACP clients (off by default since not all clients support
    // interactive question UIs). We do, so flip it on.
    const env = buildOpencodeEnv({ OPENCODE_ENABLE_QUESTION_TOOL: '1' })

    const child = spawn(binPath, ['acp', '--cwd', opts.cwd], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    active.child = child
    log.info(`spawned opencode acp pid=${child.pid} cwd=${opts.cwd}`)

    child.stderr.on('data', (data: Buffer) => {
      log.info(`opencode-acp stderr: ${truncate(data.toString())}`)
    })

    child.on('close', (code) => {
      log.info(`opencode-acp exited: code=${code} threadId=${opts.threadId}`)
      const wasActive = active.child !== null
      active.child = null
      active.connection = null
      // Reject any pending permissions so the UI doesn't hang
      for (const [reqId, pending] of active.pendingPermissions) {
        pending.resolve({ outcome: { outcome: 'cancelled' } })
        active.onEvent({ type: 'request.closed', threadId: opts.threadId, requestId: reqId, decision: 'deny' })
      }
      active.pendingPermissions.clear()
      if (wasActive) {
        active.session.status = code === 0 ? 'stopped' : 'error'
        onEvent({ type: 'status', threadId: opts.threadId, status: active.session.status })
      }
    })

    child.on('error', (err) => {
      log.error(`opencode-acp spawn error: ${err.message}`)
      active.session.status = 'error'
      onEvent({ type: 'error', threadId: opts.threadId, message: err.message })
      onEvent({ type: 'status', threadId: opts.threadId, status: 'error' })
    })

    // Bridge child stdio → WhatWG streams the SDK expects.
    const inputStream = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
    const outputStream = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    const stream = ndJsonStream(inputStream, outputStream)

    const client = this.makeClient(opts.threadId)
    const connection = new ClientSideConnection(() => client, stream)
    active.connection = connection

    try {
      const init = await connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      })
      log.info(`acp initialize: protocolVersion=${init.protocolVersion} agent=${init.agentInfo?.name ?? 'unknown'} ${init.agentInfo?.version ?? ''}`)

      const newSession: NewSessionResponse = await connection.newSession({
        cwd: opts.cwd,
        mcpServers: [],
      })
      active.sessionId = newSession.sessionId
      session.sessionId = newSession.sessionId
      log.info(`acp newSession: ${newSession.sessionId}`)

      // Capture initial model catalog
      if (newSession.models?.availableModels) {
        active.availableModels = newSession.models.availableModels
      }

      // If caller supplied a model, push it now so opencode uses it on the
      // first prompt. setSessionModel returns _meta with variant info we
      // forward to the renderer.
      if (opts.model && opts.model.length > 0) {
        try {
          await this.applyModel(opts.threadId, opts.model)
        } catch (err: any) {
          log.warn(`acp setModel failed at start: ${err?.message ?? err}`)
        }
      }

      // Push initial mode if non-default
      const acpMode = runtimeModeToAcp(session.runtimeMode)
      if (acpMode === 'plan') {
        try {
          await connection.setSessionMode({ sessionId: newSession.sessionId, modeId: acpMode })
        } catch (err: any) {
          log.warn(`acp setSessionMode failed: ${err?.message ?? err}`)
        }
      }

      active.session.status = 'idle'
      onEvent({ type: 'status', threadId: opts.threadId, status: 'idle' })
    } catch (err: any) {
      log.error(`acp init/newSession failed: ${err?.message ?? err}`)
      active.session.status = 'error'
      onEvent({ type: 'error', threadId: opts.threadId, message: `OpenCode ACP init failed: ${err?.message ?? err}` })
      onEvent({ type: 'status', threadId: opts.threadId, status: 'error' })
      // Tear down the child so the user can retry cleanly
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    }

    return session
  }

  async sendTurn(
    threadId: string,
    message: string,
    runtimeMode?: RuntimeMode,
    images?: Array<{ url: string; mimeType?: string }>,
  ): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) throw new Error(`No OpenCode ACP session: ${threadId}`)
    if (!active.connection || !active.sessionId) {
      throw new Error('OpenCode ACP session not initialized')
    }
    if (active.inFlightPrompt) {
      log.warn(`sendTurn called while turn in progress for ${threadId} — ignoring`)
      return
    }

    if (runtimeMode && runtimeMode !== active.session.runtimeMode) {
      active.session.runtimeMode = runtimeMode
      try {
        await active.connection.setSessionMode({
          sessionId: active.sessionId,
          modeId: runtimeModeToAcp(runtimeMode),
        })
      } catch (err: any) {
        log.warn(`acp setSessionMode failed: ${err?.message ?? err}`)
      }
    }

    active.session.status = 'running'
    active.turnStartedAt = Date.now()
    active.onEvent({ type: 'status', threadId, status: 'running' })

    const prompt: ContentBlock[] = []
    if (message && message.length > 0) {
      prompt.push({ type: 'text', text: message })
    }
    if (images && images.length > 0) {
      for (const img of images) {
        const { mimeType, data } = parseImageInput(img)
        if (data) {
          prompt.push({ type: 'image', mimeType: mimeType ?? 'image/png', data })
        } else if (img.url) {
          prompt.push({ type: 'image', mimeType: mimeType ?? 'image/png', uri: img.url, data: '' })
        }
      }
    }

    const sessionId = active.sessionId
    const promptPromise = active.connection.prompt({ sessionId, prompt })
      .then((res) => {
        active.session.status = 'idle'
        const durationMs =
          active.turnStartedAt != null ? Date.now() - active.turnStartedAt : undefined
        active.turnStartedAt = null
        active.onEvent({
          type: 'turn.completed',
          threadId,
          ...(res?.usage?.totalTokens !== undefined ? { usedTokens: res.usage.totalTokens } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
        active.onEvent({ type: 'status', threadId, status: 'idle' })
      })
      .catch((err: unknown) => {
        // Cancellation surfaces as `cancelled` stopReason — the SDK still
        // resolves cleanly, so this catch is for hard transport errors.
        const msg = err instanceof RequestError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
        log.error(`acp prompt failed: ${msg}`)
        active.session.status = 'error'
        active.onEvent({ type: 'error', threadId, message: msg })
        active.onEvent({ type: 'status', threadId, status: 'error' })
      })
      .finally(() => {
        active.inFlightPrompt = null
      })
    active.inFlightPrompt = promptPromise
  }

  async interruptTurn(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.connection || !active.sessionId) return
    try {
      await active.connection.cancel({ sessionId: active.sessionId })
      log.info(`acp cancel sent: ${threadId}`)
    } catch (err: any) {
      log.warn(`acp cancel failed: ${err?.message ?? err}`)
    }
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    const pending = active.pendingPermissions.get(requestId)
    if (!pending) return
    active.pendingPermissions.delete(requestId)

    const optionId = decision === 'approve' ? pending.allowOptionId : pending.rejectOptionId
    if (optionId) {
      pending.resolve({ outcome: { outcome: 'selected', optionId } })
    } else {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    active.onEvent({ type: 'request.closed', threadId, requestId, decision })
  }

  async setRuntimeMode(threadId: string, mode: RuntimeMode): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    active.session.runtimeMode = mode
    if (active.connection && active.sessionId) {
      try {
        await active.connection.setSessionMode({
          sessionId: active.sessionId,
          modeId: runtimeModeToAcp(mode),
        })
        log.info(`acp setSessionMode → ${mode} (${runtimeModeToAcp(mode)})`)
      } catch (err: any) {
        log.warn(`acp setSessionMode failed: ${err?.message ?? err}`)
      }
    }
  }

  async setModel(threadId: string, model: string): Promise<void> {
    if (!model || model.length === 0) return
    const active = this.sessions.get(threadId)
    if (!active) return
    active.session.model = model
    if (active.connection && active.sessionId) {
      await this.applyModel(threadId, model)
    }
  }

  async stopSession(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    if (active.child) {
      try { active.child.kill('SIGTERM') } catch { /* ignore */ }
      active.child = null
    }
    for (const [, pending] of active.pendingPermissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    active.pendingPermissions.clear()
    this.sessions.delete(threadId)
    log.info(`session stopped: ${threadId}`)
  }

  async listSkills(threadId: string): Promise<ProviderSkill[]> {
    const active = this.sessions.get(threadId)
    if (!active) return []
    return active.skills
  }

  /**
   * Surfaces the model catalog captured from `session/new`. Called from
   * the OPENCODE_LIST_MODELS IPC handler. This replaces the legacy
   * `opencode models` shell-out — the catalog is already in memory.
   *
   * If no session is active, falls back to an empty list (the renderer
   * will retry once a session exists).
   */
  async listAvailableModels(): Promise<string[]> {
    // Pick any active session — model catalogs are global to the binary
    // version, not per-cwd. (If the user has multiple sessions with
    // different models active, all see the same catalog.)
    for (const active of this.sessions.values()) {
      if (active.availableModels.length > 0) {
        return active.availableModels.map((m) => m.modelId)
      }
    }
    return []
  }

  // ── Internals ────────────────────────────────────────────────

  private async applyModel(threadId: string, modelId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.connection || !active.sessionId) return
    try {
      const res = await active.connection.unstable_setSessionModel({
        sessionId: active.sessionId,
        modelId,
      })
      const meta = (res?._meta as { opencode?: { modelId?: string; variant?: string | null; availableVariants?: string[] } } | undefined)?.opencode
      if (meta) {
        active.onEvent({
          type: 'model.variants',
          threadId,
          modelId: meta.modelId ?? modelId,
          availableVariants: Array.isArray(meta.availableVariants) ? meta.availableVariants : [],
          currentVariant: typeof meta.variant === 'string' ? meta.variant : '',
        })
      }
      log.info(`acp setSessionModel → ${modelId}${meta?.variant ? ` (variant=${meta.variant})` : ''}`)
    } catch (err: any) {
      log.warn(`acp setSessionModel(${modelId}) failed: ${err?.message ?? err}`)
    }
  }

  /** The Client interface we expose back to the agent over the connection. */
  private makeClient(threadId: string): Client {
    const adapter = this
    return {
      async sessionUpdate(params: SessionNotification): Promise<void> {
        const active = adapter.sessions.get(threadId)
        if (!active) return

        // available_commands_update never produces a RuntimeEvent — handled
        // adapter-side via the skills cache.
        if (params.update.sessionUpdate === 'available_commands_update') {
          active.skills = mapAvailableCommands(params.update.availableCommands ?? [])
          log.info(`acp available_commands_update: ${active.skills.length} skill(s)`)
          return
        }

        // Capture model catalog drift if it changes mid-session.
        if (params.update.sessionUpdate === 'config_option_update') {
          const opt = params.update as { configId?: string; configOptions?: unknown }
          if (opt.configId === 'model' && Array.isArray(opt.configOptions)) {
            // Best-effort: store option list when present
            log.debug('config_option_update model list refreshed')
          }
        }

        const events = mapSessionUpdate(threadId, params)
        for (const ev of events) active.onEvent(ev)
      },

      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const active = adapter.sessions.get(threadId)
        if (!active) {
          return { outcome: { outcome: 'cancelled' } }
        }

        const toolName = toolNameFromPermission(params)
        const { allow, reject } = pickPermissionOptions(params.options)
        const policy = decidePermission(active.session.runtimeMode, toolName)

        // Fast paths keep the user out of trivial decisions.
        if (policy === 'allow' && allow) {
          return { outcome: { outcome: 'selected', optionId: allow } }
        }
        if (policy === 'deny') {
          active.onEvent({
            type: 'tool.denied',
            threadId,
            toolName,
            reason: denialMessage(active.session.runtimeMode, toolName),
            mode: active.session.runtimeMode,
          })
          if (reject) {
            return { outcome: { outcome: 'selected', optionId: reject } }
          }
          return { outcome: { outcome: 'cancelled' } }
        }

        // policy === 'prompt' — bubble up to the user via approval card.
        const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        const detail = JSON.stringify(
          { tool: params.toolCall, options: params.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })) },
          null, 2,
        ).slice(0, 2000)

        return new Promise<RequestPermissionResponse>((resolve) => {
          active.pendingPermissions.set(requestId, {
            resolve,
            toolName,
            allowOptionId: allow,
            rejectOptionId: reject,
          })
          active.onEvent({
            type: 'request.opened',
            threadId,
            requestId,
            requestType: 'tool',
            toolName,
            detail,
          })
        })
      },

      async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        try {
          const content = await fs.readFile(params.path, 'utf-8')
          return { content }
        } catch (err: any) {
          throw new RequestError(-32603, `readTextFile failed: ${err?.message ?? err}`)
        }
      },

      async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
        try {
          await fs.writeFile(params.path, params.content, 'utf-8')
          return {}
        } catch (err: any) {
          throw new RequestError(-32603, `writeTextFile failed: ${err?.message ?? err}`)
        }
      },
    }
  }
}

/**
 * Normalize a Switchboard image attachment for ACP.
 * Image attachments arrive from ChatPanel as a data URL (`data:image/png;base64,…`).
 * ACP wants raw base64 in `data` + a separate `mimeType` field.
 *
 * Exported for unit tests.
 */
export function parseImageInput(
  img: { url: string; mimeType?: string },
): { mimeType: string | undefined; data: string | null } {
  if (!img.url) return { mimeType: img.mimeType, data: null }
  const m = img.url.match(/^data:([^;]+);base64,(.*)$/)
  if (m) {
    return { mimeType: m[1], data: m[2] }
  }
  return { mimeType: img.mimeType, data: null }
}

// ─── Avoid an `Agent` import warning when the Agent symbol is only used at types. ───
// The SDK's Agent type appears in client constructor docs; importing it lets
// future helpers reach for it without re-importing.
const _AgentTypeBrand: Agent | null = null
void _AgentTypeBrand
