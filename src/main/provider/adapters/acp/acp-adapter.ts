/**
 * Generic Agent Client Protocol adapter: speaks ACP (the Zed-led standard)
 * to a long-lived agent child over JSON-RPC on stdio. One class serves every
 * ACP agent; an `AcpLaunchConfig` says how to find, start and configure each
 * one (OpenCode's lives in `../opencode-acp-adapter.ts`, the others in
 * `./agents.ts`).
 *
 * The child boots once per session, after which:
 *   - `session/prompt` streams text, reasoning, tool calls, plans and usage
 *   - permissions surface as a real `requestPermission` RPC
 *   - `available_commands_update` pushes the skill list
 *   - the model catalog arrives inline on `session/new` (`models`, or a
 *     config option of category `model`)
 *
 * Wire layer: the official `@agentclientprotocol/sdk` package gives
 * `ClientSideConnection` (RPC + notifications + types) and `ndJsonStream`
 * (line framing). Node's Readable/Writable.toWeb() bridges child stdio into
 * the SDK's WhatWG-stream API.
 */

import type { TurnDelivery } from '@shared/turn-delivery'
import { takeTurnDuration } from '../../turn-duration'
import { parseImageDataUrl } from '@shared/provider-events'
import { withVisibleHistory, type VisibleHistoryState } from '../../visible-history'
import { type ChildProcessWithoutNullStreams } from 'child_process'
import spawn from 'cross-spawn'
import { Readable, Writable } from 'stream'
import { promises as fs } from 'fs'
import { inferModelTier, type ModelOption } from '@shared/models'
import { withTimeout } from '@shared/promise-timeout'
import { TurnNotAcceptedError } from '../../durable-turn-acceptance'
import {
  ClientSideConnection,
  ndJsonStream,
  RequestError,
  type AgentCapabilities,
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
  type SessionModeState,
} from '@agentclientprotocol/sdk'
import { createMainLogger as createLogger } from '../../../logger'
import type {
  ProviderAdapter,
  ProviderSession,
  SessionStartOpts,
  RuntimeEvent,
  RuntimeMode,
  ApprovalDecision,
} from '../../types'
import type { ProviderSkill } from '@shared/types'
import { decidePermission, denialMessage } from '../../policy'
import { resolveResumeSegment } from '../../../db/database'
import { acpSwitchboardMcpServer } from '../../../mcp/agent-registration'
import { markAgentSpawnEnv } from '../../agent-spawn-env'
import type { AcpExpectedCapability, AcpLaunchConfig, AcpProviderKind, AcpSessionPrep } from './launch-config'
import { acpModeFor, modelsFromConfigOptions, resolveAcpModeIds, type AcpModeIds } from './session-config'

const log = createLogger('provider:acp')
const LOG_PAYLOAD_LIMIT = 4000

/** ACP's JSON-RPC error code for "authentication required". */
const ACP_AUTH_REQUIRED = -32000

function truncate(v: string): string {
  return v.length > LOG_PAYLOAD_LIMIT
    ? `${v.slice(0, LOG_PAYLOAD_LIMIT)}…<truncated>`
    : v
}

/** The expected capabilities `initialize` did not advertise. */
export function missingCapabilities(
  caps: AgentCapabilities | null | undefined,
  expected: readonly AcpExpectedCapability[],
): AcpExpectedCapability[] {
  const has: Record<AcpExpectedCapability, boolean> = {
    loadSession: !!caps?.loadSession,
    resume: !!caps?.sessionCapabilities?.resume,
    fork: !!caps?.sessionCapabilities?.fork,
    image: !!caps?.promptCapabilities?.image,
    mcpHttp: !!caps?.mcpCapabilities?.http,
  }
  return expected.filter((cap) => !has[cap])
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

interface ActiveSession extends VisibleHistoryState {
  session: ProviderSession
  onEvent: (event: RuntimeEvent) => void
  /** The session resumed the chat's earlier agent session. */
  resumed?: boolean
  child: ChildProcessWithoutNullStreams | null
  connection: ClientSideConnection | null
  /** ACP session id returned by `session/new`. */
  sessionId: string | null
  /** The Switchboard MCP server was registered on this session. */
  switchboardMcp: boolean
  /** What the launch config worked out from the agent's own config. */
  prep: AcpSessionPrep
  /** The modes `session/new` advertised, as it advertised them (null: none). */
  advertisedModes?: SessionModeState | null
  /** The agent's current mode id, when it reports one. */
  currentModeId: string | null
  /** Set when the model picker is a session config option, not `models`. */
  modelConfigId: string | null
  /** Pending `requestPermission` calls awaiting user decision. */
  pendingPermissions: Map<string, PendingPermission>
  /** Cached skill list, kept fresh by `available_commands_update`. */
  skills: ProviderSkill[]
  /** Catalog from `session/new`: `models.availableModels`, or a model config option. */
  availableModels: ModelInfo[]
  /** In-flight prompt promise (so we know a turn is active). */
  inFlightPrompt: Promise<void> | null
  /** True while drainQueued sets up the next queued prompt (the slot stays taken). */
  drainingQueue: boolean
  /** True while a send applies its mode, before its prompt is in flight. */
  startingPrompt: boolean
  /** Messages sent with delivery 'queue' while a prompt ran, oldest first. */
  queuedTurns: Array<{ id?: string; message: string; runtimeMode?: RuntimeMode; images?: Array<{ url: string; mimeType?: string }> }>
  /** Nothing queued starts until the user resumes: a turn failed (see holdQueue). */
  queueHeld: boolean
  /** Wall-clock turn-start timestamp; null when no turn is in flight. */
  turnStartedAt: number | null
  /** Accumulates chunk deltas by messageId for text and reasoning blocks. */
  assistantMessageText: Map<string, string>
  /** The first user message of the turn, used to generate a title. */
  firstUserMessage?: string
}

/**
 * Map an ACP `SessionUpdate` into zero or more Switchboard `RuntimeEvent`s.
 *
 * Pure / exported so the unit tests don't need a live agent.
 * The adapter's `Client.sessionUpdate` handler consumes the result.
 */
export function mapSessionUpdate(
  threadId: string,
  notification: SessionNotification,
  assistantMessageText: Map<string, string>,
): RuntimeEvent[] {
  const update = notification.update
  const events: RuntimeEvent[] = []

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const delta = textFromContent(update.content)
      if (!delta) break
      const fallbackIdKey = `__fallback_id:${update.sessionUpdate}`
      let messageId = update.messageId
      if (!messageId) {
        messageId = assistantMessageText.get(fallbackIdKey)
        if (!messageId) {
          messageId = `acp_msg_${update.sessionUpdate}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
          assistantMessageText.set(fallbackIdKey, messageId)
        }
      }
      
      // The accumulated copy is kept for the fallback message id bookkeeping
      // below; only the wire carries the increment, which is what keeps a long
      // reply from costing O(n^2) bytes.
      assistantMessageText.set(messageId, `${assistantMessageText.get(messageId) ?? ''}${delta}`)

      events.push({
        type: 'content',
        threadId,
        messageId,
        text: delta,
        append: true,
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
        const writtenPaths = update.status === 'completed' ? acpEditPaths(update) : []
        events.push({
          type: 'tool.completed',
          threadId,
          toolId: update.toolCallId,
          ...(output ? { output } : {}),
          ...(writtenPaths.length > 0 ? { writtenPaths } : {}),
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
      // No RuntimeEvent for skill changes - adapter caches and the renderer
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

/** Files an ACP edit tool call wrote: its locations, plus the path its input names. */
function acpEditPaths(update: SessionUpdate & { sessionUpdate: 'tool_call_update' }): string[] {
  if (update.kind !== 'edit') return []
  const input = (typeof update.rawInput === 'object' && update.rawInput !== null ? update.rawInput : {}) as Record<string, unknown>
  return [
    ...(update.locations ?? []).map((l) => l.path),
    ...(typeof input.filePath === 'string' ? [input.filePath] : []),
  ]
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
    } catch (err) {
      log.debug('failed to stringify ACP tool output', { err })
      return String(update.rawOutput)
    }
  }
  return null
}

/**
 * Convert an `available_commands_update` payload into Switchboard skills.
 * Exported pure for unit tests.
 */
export function mapAvailableCommands(commands: AvailableCommand[], source: AcpProviderKind = 'opencode'): ProviderSkill[] {
  const out: ProviderSkill[] = []
  const seen = new Set<string>()
  for (const cmd of commands) {
    const name = cmd.name?.replace(/^\$/, '').replace(/^\//, '').trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({
      name,
      ...(cmd.description ? { description: cmd.description } : {}),
      source,
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

/** Plain prep for an agent with no config of its own to read. */
function defaultSessionPrep(env: Record<string, string>): AcpSessionPrep {
  return {
    env,
    mcpServerNames: [],
    autoAllowSwitchboardTool: () => false,
    displayToolName: (toolName) => toolName,
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Ceiling on the whole ACP handshake: `initialize` through `resumeSession`
 * or `newSession`. An agent binary that does an interactive first-run or
 * sign-in step instead of speaking ACP never answers these calls, which
 * without a deadline leaves the session in 'connecting' forever with no
 * error. Same shared `withTimeout` codex-adapter uses for its own
 * `initialize` RPC (`INIT_TIMEOUT_MS`, 30s) - ACP's is longer because it
 * also covers resume/new-session, and because OpenCode's free tier can take
 * up to a few minutes to cold-boot (see AGENTS.md).
 * ponytail: 3 minutes matches that documented OpenCode cold-boot ceiling,
 * so a slow but real first boot still finishes inside it.
 */
export const ACP_HANDSHAKE_TIMEOUT_MS = 180_000
const ACP_HANDSHAKE_OP = 'ACP handshake'
/** Matches the error `withTimeout` produces for `ACP_HANDSHAKE_OP` - mirrors `updater-error.ts`'s `CHECK_TIMEOUT_RE`. */
const ACP_HANDSHAKE_TIMEOUT_RE = new RegExp(`^${ACP_HANDSHAKE_OP} timed out after \\d+ms$`)

/**
 * One ACP agent, driven by its launch config. The registry holds one
 * instance per agent kind; each keeps a long-lived child per session.
 */
export class AcpAdapter implements ProviderAdapter {
  readonly provider: AcpProviderKind
  private sessions = new Map<string, ActiveSession>()

  constructor(private readonly config: AcpLaunchConfig) {
    this.provider = config.provider
  }

  async isAvailable(): Promise<boolean> {
    return this.config.findBinary() !== null
  }

  async startSession(
    opts: SessionStartOpts,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<ProviderSession> {
    const { config } = this
    const binPath = config.findBinary()
    if (!binPath) throw new Error(config.notFoundMessage)

    // Provider-instance env vars (API keys and the like) overlay the config's
    // own layers, so per-instance keys win.
    const overlay: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.resolvedEnv ?? {})) {
      if (v.length > 0) overlay[k] = v
    }
    const baseEnv = config.buildEnv(overlay)
    // Before any session state exists, so a refused binary leaves nothing to clean up.
    await config.preflight?.(binPath, baseEnv, opts.cwd)

    const session: ProviderSession = {
      threadId: opts.threadId,
      provider: this.provider,
      status: 'connecting',
      model: opts.model,
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: Date.now(),
      instanceId: opts.instanceId,
    }

    const active: ActiveSession = {
      session,
      onEvent,
      portableHistory: opts.portableHistory,
      child: null,
      connection: null,
      sessionId: null,
      switchboardMcp: !!opts.switchboardMcp,
      prep: defaultSessionPrep(baseEnv),
      advertisedModes: null,
      currentModeId: null,
      modelConfigId: null,
      pendingPermissions: new Map(),
      skills: [],
      availableModels: [],
      inFlightPrompt: null,
      drainingQueue: false,
      startingPrompt: false,
      queuedTurns: [],
      queueHeld: false,
      turnStartedAt: null,
      assistantMessageText: new Map(),
    }
    this.sessions.set(opts.threadId, active)

    onEvent({ type: 'status', threadId: opts.threadId, status: 'connecting' })

    if (config.prepareSession) {
      active.prep = await config.prepareSession({
        cwd: opts.cwd,
        env: baseEnv,
        runtimeMode: session.runtimeMode,
        switchboardMcp: active.switchboardMcp,
      })
    }

    // `cross-spawn`, not `child_process.spawn` directly: every generic ACP
    // agent (gemini, vibe-acp, cline, copilot) is a global npm/uv install,
    // and on Windows those resolve to a `.cmd`/`.bat` shim that plain
    // `spawn()` cannot execute without a shell. cross-spawn detects that
    // case itself and launches through `cmd.exe` with each argument quoted
    // and shell metacharacters escaped, so a cwd or arg containing spaces or
    // `&`/`|`/`"` cannot break the command line or inject one. It is an
    // exact passthrough to `child_process.spawn` on macOS/Linux.
    const child = spawn(binPath, config.args(opts.cwd), {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: markAgentSpawnEnv(active.prep.env),
    }) as ChildProcessWithoutNullStreams
    active.child = child
    log.info(`spawned ${this.provider} acp pid=${child.pid} cwd=${opts.cwd}`)

    child.stderr.on('data', (data: Buffer) => {
      log.info(`${this.provider} acp stderr: ${truncate(data.toString())}`)
    })

    child.on('close', (code) => {
      log.info(`${this.provider} acp exited: code=${code} threadId=${opts.threadId}`)
      const wasActive = active.child !== null
      active.child = null
      active.connection = null
      // Reject any pending permissions so the UI doesn't hang
      for (const [reqId, pending] of active.pendingPermissions) {
        pending.resolve({ outcome: { outcome: 'cancelled' } })
        active.onEvent({ type: 'request.closed', threadId: opts.threadId, requestId: reqId, decision: 'deny' })
      }
      active.pendingPermissions.clear()
      this.dropQueuedOnExit(opts.threadId, active)
      if (wasActive) {
        active.session.status = code === 0 ? 'stopped' : 'error'
        onEvent({ type: 'status', threadId: opts.threadId, status: active.session.status })
      }
    })

    child.on('error', (err) => {
      log.error(`${this.provider} acp spawn error: ${err.message}`)
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
      const { newSession, resumeId } = await withTimeout(
        (async () => {
          const init = await connection.initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
            },
          })
          log.info(`acp initialize: protocolVersion=${init.protocolVersion} agent=${init.agentInfo?.name ?? 'unknown'} ${init.agentInfo?.version ?? ''}`)
          const missing = missingCapabilities(init.agentCapabilities, config.expectedCapabilities)
          if (missing.length > 0) log.warn(`${this.provider} acp does not advertise expected capabilities: ${missing.join(', ')}`)

          // No agent-digest prompt rule here: ACP's `NewSessionRequest` carries
          // only `cwd`/`mcpServers`/`additionalDirectories` (checked against
          // @agentclientprotocol/sdk's types.gen.d.ts) - there is no
          // system/developer instructions seam to append it to, and `prompt`
          // content blocks are the user's own message, not an instructions
          // channel. ACP sessions do not get the digest rule; previews for them
          // fall back to today's behavior. See docs/feature-parity/agent-digest.json.
          // The agent also loads the MCP servers in the user's own config.
          const mcpServers = opts.switchboardMcp ? [acpSwitchboardMcpServer(opts.switchboardMcp)] : []
          // The session this chat last ran (or a native fork's), when the agent
          // can resume one; otherwise a new session, which starts without the
          // chat's earlier context.
          const canResume = Boolean(init.agentCapabilities?.sessionCapabilities?.resume)
          const resumeId = canResume ? this.resumeTarget(opts) : null
          // An agent that cannot resume starts this chat's next session blind.
          if (!canResume && this.resumeTarget(opts)) active.needsVisibleHistory = true
          let newSession: Pick<NewSessionResponse, 'sessionId' | 'models' | 'modes' | 'configOptions'> | null = null
          if (resumeId) {
            try {
              const resumed = await connection.resumeSession({ sessionId: resumeId, cwd: opts.cwd, mcpServers })
              newSession = { sessionId: resumeId, models: resumed?.models, modes: resumed?.modes, configOptions: resumed?.configOptions }
              active.resumed = true
            } catch (err) {
              const reason = errorText(err)
              log.warn(`acp resumeSession ${resumeId} failed, starting a new session: ${reason}`)
              active.needsVisibleHistory = true
              onEvent({
                type: 'error',
                threadId: opts.threadId,
                message: `Could not resume ${config.label} session ${resumeId}; this chat continues in a new session with the visible conversation as context. ${reason}`,
              })
            }
          }
          newSession ??= await connection.newSession({ cwd: opts.cwd, mcpServers })
          return { newSession, resumeId }
        })(),
        ACP_HANDSHAKE_TIMEOUT_MS,
        ACP_HANDSHAKE_OP,
      )
      active.sessionId = newSession.sessionId
      session.sessionId = newSession.sessionId
      log.info(`acp ${resumeId === newSession.sessionId ? 'resumeSession' : 'newSession'}: ${newSession.sessionId}`)
      onEvent({ type: 'session', threadId: opts.threadId, sessionId: newSession.sessionId })

      // Capture the initial model catalog: `models` when the agent sends it,
      // else a model picker among its config options.
      const configModels = newSession.models?.availableModels ? null : modelsFromConfigOptions(newSession.configOptions)
      if (newSession.models?.availableModels) {
        active.availableModels = newSession.models.availableModels
      } else if (configModels) {
        active.availableModels = configModels.models
        active.modelConfigId = configModels.configId
      }
      active.advertisedModes = newSession.modes ?? null
      active.currentModeId = newSession.modes?.currentModeId ?? null

      // If caller supplied a model, push it now so the agent uses it on the
      // first prompt. OpenCode's set_model returns _meta with variant info we
      // forward to the renderer.
      if (opts.model && opts.model.length > 0) {
        try {
          await this.applyModel(opts.threadId, opts.model)
        } catch (err) {
          log.warn(`acp setModel failed at start: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Push the initial mode when it differs from the one the session starts in.
      const acpMode = acpModeFor(this.modeIds(active), session.runtimeMode)
      const startsIn = config.modes.kind === 'fixed' ? config.modes.other : active.currentModeId
      if (acpMode && acpMode !== startsIn) await this.applyMode(active, acpMode)

      active.session.status = 'idle'
      onEvent({ type: 'status', threadId: opts.threadId, status: 'idle' })
    } catch (err) {
      log.error(`acp init/newSession failed: ${errorText(err)}`)
      active.session.status = 'error'
      const timedOut = err instanceof Error && ACP_HANDSHAKE_TIMEOUT_RE.test(err.message)
      const needsSignIn = err instanceof RequestError && err.code === ACP_AUTH_REQUIRED
      const message = timedOut
        ? `${config.label} did not answer over ACP within ${ACP_HANDSHAKE_TIMEOUT_MS / 1000}s. Run it once in a terminal to finish any first-run or sign-in step, then try again.`
        : `${config.label} ACP init failed: ${errorText(err)}${needsSignIn ? ` ${config.signInHint}` : ''}`
      onEvent({ type: 'error', threadId: opts.threadId, message })
      onEvent({ type: 'status', threadId: opts.threadId, status: 'error' })
      // Tear down the child so the user can retry cleanly
      try {
        child.kill('SIGTERM')
      } catch (killErr) {
        log.debug(`SIGTERM on ${this.provider} child failed during init cleanup`, { threadId: opts.threadId, killErr })
      }
      active.child = null
      active.connection = null
      this.sessions.delete(opts.threadId)
      throw new Error(message)
    }

    return session
  }

  private resumeTarget(opts: SessionStartOpts): string | null {
    try {
      const segment = resolveResumeSegment(opts.threadId, this.provider, opts.instanceId)
      // Instances can keep sessions in different data dirs, so never cross one.
      if (!segment || segment.provider_instance_id !== (opts.instanceId ?? null)) return null
      return segment.provider_session_id
    } catch (err) {
      log.warn(`resolveResumeSegment failed - starting a new ${this.config.label} session`, { threadId: opts.threadId, err })
      return null
    }
  }

  /**
   * Start the oldest queued message. The slot stays reserved until its prompt
   * is in flight; one that cannot start is reported and resolved with a
   * turn.completed (which the registry counts), and the next one is tried.
   */
  private drainQueued(threadId: string, active: ActiveSession): void {
    const next = active.queueHeld ? undefined : active.queuedTurns.shift()
    if (!next) {
      active.drainingQueue = false
      return
    }
    active.drainingQueue = true
    if (next.id) active.onEvent({ type: 'turn.dequeued', threadId, messageId: next.id, reason: 'started' })
    this.deliverTurn(threadId, next.message, next.runtimeMode, next.images, undefined, undefined, true)
      .then(() => { active.drainingQueue = false })
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err)
        log.warn(`queued ${this.provider} turn failed to start for ${threadId}: ${reason}`)
        active.onEvent({ type: 'error', threadId, message: `A queued message could not be sent: ${reason}` })
        if (next.id) active.onEvent({ type: 'turn.dequeued', threadId, messageId: next.id, reason: 'failed', error: reason })
        active.onEvent({ type: 'turn.completed', threadId })
        // The next one would most likely fail the same way.
        this.holdQueue(threadId, active, 'A queued message could not be sent.')
        this.drainQueued(threadId, active)
      })
  }

  /**
   * Stop starting queued messages after a failed turn: the next one would
   * run straight into the same failure. The user resumes or cancels them.
   */
  private holdQueue(threadId: string, active: ActiveSession, reason: string): void {
    if (active.queueHeld || active.queuedTurns.length === 0) return
    active.queueHeld = true
    log.info(`holding ${active.queuedTurns.length} queued message(s) on ${threadId}: ${reason}`)
    active.onEvent({ type: 'turn.queue-held', threadId, held: true, reason })
  }

  async resumeQueuedTurns(threadId: string): Promise<boolean> {
    const active = this.sessions.get(threadId)
    if (!active?.queueHeld) return false
    active.queueHeld = false
    active.onEvent({ type: 'turn.queue-held', threadId, held: false })
    if (active.inFlightPrompt === null && !active.startingPrompt && !active.drainingQueue) this.drainQueued(threadId, active)
    return true
  }

  async sendTurn(
    threadId: string,
    message: string,
    runtimeMode?: RuntimeMode,
    images?: Array<{ url: string; mimeType?: string }>,
    delivery?: TurnDelivery,
    queuedId?: string,
  ): Promise<void> {
    return this.deliverTurn(threadId, message, runtimeMode, images, delivery, queuedId, false)
  }

  /**
   * The process is gone, so nothing queued can run. Announce each message as
   * dropped and end its accepted turn, so the registry does not wait on it.
   */
  private dropQueuedOnExit(threadId: string, active: ActiveSession): void {
    const dropped = active.queuedTurns.splice(0)
    if (dropped.length === 0) return
    log.warn(`dropping ${dropped.length} queued message(s): the process exited before they ran`, { threadId })
    active.onEvent({
      type: 'error',
      threadId,
      message: `${dropped.length === 1 ? 'A queued message was' : `${dropped.length} queued messages were`} not sent because the session stopped. Send again.`,
    })
    for (const turn of dropped) {
      if (turn.id) active.onEvent({ type: 'turn.dequeued', threadId, messageId: turn.id, reason: 'dropped' })
      active.onEvent({ type: 'turn.completed', threadId })
    }
  }

  /** ACP has no steer, so a queued message can only be taken back. */
  async cancelQueuedTurn(threadId: string, queuedId: string): Promise<boolean> {
    const active = this.sessions.get(threadId)
    const index = active?.queuedTurns.findIndex((turn) => turn.id === queuedId) ?? -1
    if (!active || index < 0) return false
    active.queuedTurns.splice(index, 1)
    active.onEvent({ type: 'turn.dequeued', threadId, messageId: queuedId, reason: 'cancelled' })
    return true
  }

  private async deliverTurn(
    threadId: string,
    message: string,
    runtimeMode: RuntimeMode | undefined,
    images: Array<{ url: string; mimeType?: string }> | undefined,
    delivery: TurnDelivery | undefined,
    queuedId: string | undefined,
    /** Set only by drainQueued, which already holds the prompt slot. */
    fromQueue: boolean,
  ): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) throw new Error(`No ${this.config.label} ACP session: ${threadId}`)
    if (!active.connection || !active.sessionId) {
      throw new Error(`${this.config.label} ACP session not initialized`)
    }
    // An ACP agent cannot take a mid-turn message; a queued one waits here and
    // is sent when the running prompt settles.
    // While a queued message is being set up the slot counts as busy, or a
    // new send could start a second prompt ahead of it.
    const busy = active.inFlightPrompt !== null || active.startingPrompt || (active.drainingQueue && !fromQueue)
    if (busy && delivery === 'queue') {
      // A message joining an empty queue starts a new one, not held.
      if (active.queuedTurns.length === 0) active.queueHeld = false
      active.queuedTurns.push({ id: queuedId, message, runtimeMode, images })
      if (queuedId) active.onEvent({ type: 'turn.queued', threadId, messageId: queuedId })
      return
    }
    // Refused, not ignored: resolving here would store the message as sent
    // while the agent never sees it.
    if (busy) {
      log.warn(`sendTurn refused while a turn is in progress for ${threadId}`)
      throw new TurnNotAcceptedError(`${this.config.label} is mid-turn and cannot take another message yet`)
    }
    // Hold the slot across the mode await below, or a queued send arriving
    // now would start its own prompt ahead of this one.
    active.startingPrompt = true
    message = await withVisibleHistory(active, threadId, message)

    if (runtimeMode && runtimeMode !== active.session.runtimeMode) {
      active.session.runtimeMode = runtimeMode
      const modeId = acpModeFor(this.modeIds(active), runtimeMode)
      if (modeId) await this.applyMode(active, modeId)
    }

    active.session.status = 'running'
    active.turnStartedAt = Date.now()
    active.assistantMessageText.clear()
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
    let dispatchedPrompt: ReturnType<ClientSideConnection['prompt']>
    try {
      dispatchedPrompt = active.connection.prompt({ sessionId, prompt })
    } catch (error) {
      active.session.status = 'idle'
      active.turnStartedAt = null
      active.startingPrompt = false
      active.onEvent({ type: 'status', threadId, status: 'idle' })
      // Messages queued behind this prompt have no settle to wait for.
      if (!fromQueue) this.drainQueued(threadId, active)
      throw new TurnNotAcceptedError(
        error instanceof Error ? error.message : `${this.config.label} rejected the turn before dispatch`,
        { cause: error },
      )
    }

    const promptPromise = dispatchedPrompt
      .then((res) => {
        active.session.status = 'idle'
        const durationMs = takeTurnDuration(active)
        active.onEvent({
          type: 'turn.completed',
          threadId,
          ...(res?.usage?.totalTokens !== undefined ? { usedTokens: res.usage.totalTokens } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
        active.onEvent({ type: 'status', threadId, status: 'idle' })
      })
      .catch((err: unknown) => {
        // Cancellation surfaces as `cancelled` stopReason - the SDK still
        // resolves cleanly, so this catch is for hard transport errors.
        const msg = err instanceof RequestError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
        log.error(`acp prompt failed: ${msg}`)
        active.session.status = 'error'
        active.onEvent({ type: 'error', threadId, message: msg })
        // The failed prompt still ends its turn, which the registry counts.
        // The queue behind it is held, not started.
        this.holdQueue(threadId, active, msg)
        active.onEvent({ type: 'turn.completed', threadId })
        active.onEvent({ type: 'status', threadId, status: 'error' })
      })
      .finally(() => {
        active.inFlightPrompt = null
        this.drainQueued(threadId, active)
      })
    active.inFlightPrompt = promptPromise
    active.startingPrompt = false

    // Only after the ACP connection has accepted the prompt invocation: an
    // OpenCode summary makes the session visible to scanners.
    if (!active.firstUserMessage) {
      active.firstUserMessage = message
      try {
        await this.config.onFirstPrompt?.({ sessionId, message, session: active.session })
      } catch (err) {
        log.warn(`${this.provider} first-prompt hook failed: ${errorText(err)}`)
      }
    }
  }

  async interruptTurn(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.connection || !active.sessionId) return
    // Stop means stop: the queued messages wait for Resume or Cancel instead
    // of starting when the cancelled prompt ends.
    this.holdQueue(threadId, active, 'Stopped.')
    try {
      await active.connection.cancel({ sessionId: active.sessionId })
      log.info(`acp cancel sent: ${threadId}`)
    } catch (err) {
      log.warn(`acp cancel failed: ${err instanceof Error ? err.message : String(err)}`)
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

  resumedNativeSession(threadId: string): boolean {
    return this.sessions.get(threadId)?.resumed === true
  }

  runtimeModeOf(threadId: string): RuntimeMode | undefined {
    return this.sessions.get(threadId)?.session.runtimeMode
  }

  async setRuntimeMode(threadId: string, mode: RuntimeMode): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    active.session.runtimeMode = mode
    const modeId = acpModeFor(this.modeIds(active), mode)
    if (modeId && await this.applyMode(active, modeId)) log.info(`acp setSessionMode → ${mode} (${modeId})`)
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
      try {
        active.child.kill('SIGTERM')
      } catch (killErr) {
        log.debug(`SIGTERM on ${this.provider} child failed during stopSession`, { threadId, killErr })
      }
      active.child = null
    }
    for (const [, pending] of active.pendingPermissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    active.pendingPermissions.clear()
    for (const turn of active.queuedTurns.splice(0)) {
      if (turn.id) active.onEvent({ type: 'turn.dequeued', threadId, messageId: turn.id, reason: 'dropped' })
    }
    this.sessions.delete(threadId)
    log.info(`session stopped: ${threadId}`)
  }

  async listSkills(threadId: string): Promise<ProviderSkill[]> {
    const active = this.sessions.get(threadId)
    if (!active) return []
    return active.skills
  }

  /**
   * The catalog `session/new` returned, in the same shape the Claude and
   * Codex adapters give LIST_MODELS, so every client (desktop, phone) reads
   * ACP models through one channel. This thread's catalog first; any
   * other session's otherwise, since the list belongs to the binary, not
   * the cwd. Empty until a session has started; clients retry.
   */
  async listModels(threadId: string): Promise<ModelOption[]> {
    const own = this.sessions.get(threadId)?.availableModels ?? []
    const catalog = own.length > 0
      ? own
      : [...this.sessions.values()].find((s) => s.availableModels.length > 0)?.availableModels ?? []
    return catalog.map((m) => ({
      id: m.modelId,
      label: this.config.modelLabel(m),
      tier: inferModelTier(m.modelId),
    }))
  }

  // ── Internals ────────────────────────────────────────────────

  private modeIds(active: ActiveSession): AcpModeIds {
    return resolveAcpModeIds(this.config.modes, active.advertisedModes)
  }

  /** Set the agent's mode; true when it took. A refusal is logged, not thrown. */
  private async applyMode(active: ActiveSession, modeId: string): Promise<boolean> {
    if (!active.connection || !active.sessionId) return false
    if (this.config.modes.kind === 'advertised' && modeId === active.currentModeId) return true
    try {
      await active.connection.setSessionMode({ sessionId: active.sessionId, modeId })
      active.currentModeId = modeId
      return true
    } catch (err) {
      log.warn(`acp setSessionMode failed: ${errorText(err)}`)
      return false
    }
  }

  private async applyModel(threadId: string, modelId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.connection || !active.sessionId) return
    try {
      if (active.modelConfigId) {
        await active.connection.setSessionConfigOption({
          sessionId: active.sessionId,
          configId: active.modelConfigId,
          value: modelId,
        })
        log.info(`acp setSessionConfigOption ${active.modelConfigId} → ${modelId}`)
        return
      }
      const res = await active.connection.unstable_setSessionModel({
        sessionId: active.sessionId,
        modelId,
      })
      const variants = this.config.modelVariants?.(res?._meta) ?? null
      if (variants) {
        active.onEvent({
          type: 'model.variants',
          threadId,
          modelId: variants.modelId ?? modelId,
          availableVariants: variants.availableVariants,
          currentVariant: variants.variant,
        })
      }
      log.info(`acp setSessionModel → ${modelId}${variants?.variant ? ` (variant=${variants.variant})` : ''}`)
    } catch (err) {
      log.warn(`acp setSessionModel(${modelId}) failed: ${errorText(err)}`)
    }
  }

  /** The Client interface we expose back to the agent over the connection. */
  private makeClient(threadId: string): Client {
    const adapter = this
    return {
      async sessionUpdate(params: SessionNotification): Promise<void> {
        const active = adapter.sessions.get(threadId)
        if (!active) return

        // available_commands_update never produces a RuntimeEvent - handled
        // adapter-side via the skills cache.
        if (params.update.sessionUpdate === 'available_commands_update') {
          active.skills = mapAvailableCommands(params.update.availableCommands ?? [], adapter.provider)
          log.info(`acp available_commands_update: ${active.skills.length} skill(s)`)
          return
        }

        if (params.update.sessionUpdate === 'current_mode_update') {
          active.currentModeId = params.update.currentModeId
        }

        // The model catalog can change mid-session for agents that carry it
        // as a config option.
        if (params.update.sessionUpdate === 'config_option_update' && active.modelConfigId) {
          const configModels = modelsFromConfigOptions(params.update.configOptions)
          if (configModels) active.availableModels = configModels.models
        }

        const events = mapSessionUpdate(threadId, params, active.assistantMessageText)
        for (const ev of events) active.onEvent(ev)
      },

      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const active = adapter.sessions.get(threadId)
        if (!active) {
          return { outcome: { outcome: 'cancelled' } }
        }

        const toolName = toolNameFromPermission(params)
        const { allow, reject } = pickPermissionOptions(params.options)
        // For our own MCP tools the server already enforces plan mode and
        // shows the card; the launch config decides which names are ours.
        if (active.switchboardMcp && allow && active.prep.autoAllowSwitchboardTool(toolName, active.session.runtimeMode)) {
          return { outcome: { outcome: 'selected', optionId: allow } }
        }
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

        // policy === 'prompt' - bubble up to the user via approval card.
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
            toolName: active.prep.displayToolName(toolName),
            detail,
          })
        })
      },

      async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        try {
          const content = await fs.readFile(params.path, 'utf-8')
          return { content }
        } catch (err) {
          throw new RequestError(-32603, `readTextFile failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
        try {
          await fs.writeFile(params.path, params.content, 'utf-8')
          return {}
        } catch (err) {
          throw new RequestError(-32603, `writeTextFile failed: ${err instanceof Error ? err.message : String(err)}`)
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
  const parsed = img.url ? parseImageDataUrl(img.url) : null
  return parsed ?? { mimeType: img.mimeType, data: null }
}
