/**
 * Codex app-server adapter.
 *
 * Spawns `codex app-server` as a child process and communicates
 * via JSON-RPC 2.0 over newline-delimited JSON on stdio.
 */

import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { createMainLogger as createLogger } from '../../logger'
import type {
  ProviderAdapter,
  ProviderSession,
  SessionStartOpts,
  RuntimeEvent,
  RuntimeMode,
  ApprovalDecision,
} from '../types'
import { decidePermission, denialMessage } from '../policy'
import type { ProviderSkill } from '@shared/types'

/**
 * Map our runtime modes to Codex app-server approval policies.
 *
 * Codex's own policies:
 *   - `never`       -> auto-approve everything (our full-access)
 *   - `on-request`  → ask per tool (our sandbox)
 *   - `untrusted`   → deny non-read tools (our plan)
 *
 * Our policy still gates via decidePermission() for correctness — this
 * mapping is best-effort for Codex to bias its own asking behavior.
 */
const RUNTIME_MODE_TO_CODEX_POLICY: Record<RuntimeMode, string> = {
  'plan': 'untrusted',
  'sandbox': 'on-request',
  'accept-edits': 'on-request',
  'full-access': 'never',
}

const RUNTIME_MODE_TO_CODEX_THREAD_SANDBOX: Record<RuntimeMode, string> = {
  'plan': 'read-only',
  'sandbox': 'read-only',
  'accept-edits': 'workspace-write',
  'full-access': 'danger-full-access',
}

const RUNTIME_MODE_TO_CODEX_TURN_SANDBOX: Record<RuntimeMode, { type: string }> = {
  'plan': { type: 'readOnly' },
  'sandbox': { type: 'readOnly' },
  'accept-edits': { type: 'workspaceWrite' },
  'full-access': { type: 'dangerFullAccess' },
}

const SWITCHBOARD_CLIENT_INFO = {
  name: 'switchboard',
  title: 'Switchboard',
  version: '0.1.0',
}

const log = createLogger('provider:codex')
const LOG_PAYLOAD_LIMIT = 4000

function truncateLogPayload(value: string): string {
  return value.length > LOG_PAYLOAD_LIMIT
    ? `${value.slice(0, LOG_PAYLOAD_LIMIT)}…<truncated ${value.length - LOG_PAYLOAD_LIMIT} chars>`
    : value
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface PendingRpc {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

interface PendingApproval {
  jsonRpcId: number
  requestId: string
}

interface ActiveSession {
  session: ProviderSession
  child: ChildProcessWithoutNullStreams | null
  onEvent: (event: RuntimeEvent) => void
  nextRpcId: number
  pendingRpcs: Map<number, PendingRpc>
  pendingApprovals: Map<string, PendingApproval>
  assistantMessageText: Map<string, string>
  threadId: string | null
  /** Cached `skills/list` response. Populated on first listSkills() call. */
  skills: ProviderSkill[] | null
  /** Wall-clock turn-start timestamp; null when no turn is in flight. */
  turnStartedAt: number | null
}

/**
 * Normalize Codex's `skills/list` response into ProviderSkill shape.
 * Codex's wire shape (per app-server v2): `{ skills: [{ name, description? }] }`.
 * Be defensive — accept top-level array too in case the schema shifts.
 */
export function parseCodexSkills(input: unknown): ProviderSkill[] {
  const arr = Array.isArray(input)
    ? input
    : (input && typeof input === 'object' && Array.isArray((input as any).skills))
      ? (input as any).skills
      : []
  const out: ProviderSkill[] = []
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const rawName = typeof obj.name === 'string' ? obj.name : null
    if (!rawName) continue
    const name = rawName.replace(/^\$/, '').replace(/^\//, '').trim()
    if (!name) continue
    const description = typeof obj.description === 'string' ? obj.description : undefined
    const argumentHint = typeof obj.argumentHint === 'string'
      ? obj.argumentHint
      : (typeof obj.argument_hint === 'string' ? obj.argument_hint : undefined)
    out.push({
      name,
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      source: 'codex',
    })
  }
  const seen = new Set<string>()
  return out.filter((s) => {
    const k = s.name.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Find codex binary */
function findCodexPath(): string | null {
  const home = process.env.HOME || ''
  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    `${home}/.npm-global/bin/codex`,
  ]

  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { timeout: 2000 })
      return p
    } catch { /* not found */ }
  }

  try {
    return execSync('which codex 2>/dev/null', {
      encoding: 'utf-8', timeout: 5000,
    }).trim().split('\n')[0] || null
  } catch {
    return null
  }
}

let cachedCodexPath: string | null | undefined

export class CodexAdapter implements ProviderAdapter {
  readonly provider = 'codex' as const
  private sessions = new Map<string, ActiveSession>()

  async isAvailable(): Promise<boolean> {
    if (cachedCodexPath === undefined) {
      cachedCodexPath = findCodexPath()
    }
    return cachedCodexPath !== null
  }

  async startSession(
    opts: SessionStartOpts,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<ProviderSession> {
    if (cachedCodexPath === undefined) {
      cachedCodexPath = findCodexPath()
    }
    if (!cachedCodexPath) {
      throw new Error('Codex CLI not found. Install with: npm install -g @openai/codex')
    }

    const session: ProviderSession = {
      threadId: opts.threadId,
      provider: 'codex',
      status: 'connecting',
      model: opts.model,
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: Date.now(),
      reasoningEffort: opts.reasoningEffort,
    }

    const active: ActiveSession = {
      session,
      child: null,
      onEvent,
      nextRpcId: 1,
      pendingRpcs: new Map(),
      pendingApprovals: new Map(),
      assistantMessageText: new Map(),
      threadId: null,
      skills: null,
      turnStartedAt: null,
    }

    this.sessions.set(opts.threadId, active)

    // Spawn codex app-server
    const child = spawn(cachedCodexPath, ['app-server'], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    active.child = child

    // Parse stdout as newline-delimited JSON
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      log.debug(`codex -> ${truncateLogPayload(line)}`)
      try {
        const parsed = JSON.parse(line)
        this.handleMessage(opts.threadId, active, parsed)
      } catch {
        log.warn(`invalid JSON from codex: ${line.slice(0, 200)}`)
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      log.warn(`codex stderr: ${truncateLogPayload(data.toString())}`)
    })

    child.on('close', (code) => {
      log.info(`codex process exited: code=${code}`)
      active.child = null
      active.session.status = code === 0 ? 'stopped' : 'error'
      onEvent({ type: 'status', threadId: opts.threadId, status: active.session.status })
    })

    child.on('error', (err) => {
      active.child = null
      active.session.status = 'error'
      onEvent({ type: 'error', threadId: opts.threadId, message: err.message })
      onEvent({ type: 'status', threadId: opts.threadId, status: 'error' })
    })

    // Send initialize RPC
    try {
      await this.sendRpc(active, 'initialize', {
        clientInfo: SWITCHBOARD_CLIENT_INFO,
        capabilities: {
          experimentalApi: true,
        },
      })
      this.sendNotification(active, 'initialized')
      active.session.status = 'idle'
      onEvent({ type: 'status', threadId: opts.threadId, status: 'idle' })
    } catch (err: any) {
      active.session.status = 'error'
      onEvent({ type: 'error', threadId: opts.threadId, message: `Init failed: ${err.message}` })
    }

    log.info(`session started: ${opts.threadId}`)
    return session
  }

  async sendTurn(
    threadId: string,
    message: string,
    runtimeMode?: RuntimeMode,
    images?: Array<{ url: string; mimeType?: string }>,
  ): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.child) throw new Error(`Session ${threadId} not found or not connected`)

    // Pick up mode override (same semantics as claude-adapter)
    if (runtimeMode && runtimeMode !== active.session.runtimeMode) {
      active.session.runtimeMode = runtimeMode
    }

    active.session.status = 'running'
    active.turnStartedAt = Date.now()
    active.onEvent({ type: 'status', threadId, status: 'running' })

    const approvalPolicy = RUNTIME_MODE_TO_CODEX_POLICY[active.session.runtimeMode] ?? 'on-request'

    // Build current Codex app-server v2 user input blocks.
    const content: Array<Record<string, unknown>> = []
    if (message) {
      content.push({ type: 'text', text: message })
    }
    if (images && images.length > 0) {
      for (const img of images) {
        // Codex accepts data URLs directly — no need to strip the prefix.
        content.push({ type: 'image', url: img.url })
      }
    }

    const reasoningEffort = active.session.reasoningEffort
    const sandbox = RUNTIME_MODE_TO_CODEX_THREAD_SANDBOX[active.session.runtimeMode] ?? 'read-only'
    const sandboxPolicy = RUNTIME_MODE_TO_CODEX_TURN_SANDBOX[active.session.runtimeMode] ?? { type: 'readOnly' }

    try {
      if (!active.threadId) {
        const result = await this.sendRpc(active, 'thread/start', {
          cwd: active.session.cwd,
          approvalPolicy,
          sandbox,
          ...(active.session.model ? { model: active.session.model } : {}),
        })
        active.threadId = (result as any)?.thread?.id ?? (result as any)?.threadId ?? null
        if (!active.threadId) {
          throw new Error('Codex thread/start did not return a thread id')
        }
      }

      await this.sendRpc(active, 'turn/start', {
        threadId: active.threadId,
        input: content,
        approvalPolicy,
        sandboxPolicy,
        cwd: active.session.cwd,
        ...(active.session.model ? { model: active.session.model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
      })
    } catch (err: any) {
      active.session.status = 'error'
      active.onEvent({
        type: 'error',
        threadId,
        message: err.message,
      })
    }
  }

  async listSkills(threadId: string): Promise<ProviderSkill[]> {
    const active = this.sessions.get(threadId)
    if (!active?.child) return []
    if (active.skills) return active.skills
    try {
      const result = await this.sendRpc(active, 'skills/list', {})
      const parsed = parseCodexSkills(result)
      active.skills = parsed
      log.info(`captured ${parsed.length} codex skills`)
      return parsed
    } catch (err: any) {
      // Older codex builds don't expose skills/list — cache empty so we
      // don't keep retrying every time the user opens the slash menu.
      log.warn(`skills/list unavailable: ${err?.message ?? err}`)
      active.skills = []
      return []
    }
  }

  async interruptTurn(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.child || !active.threadId) return

    try {
      await this.sendRpc(active, 'turn/interrupt', { threadId: active.threadId })
    } catch {
      // May fail if no turn active
    }
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.child) return

    const pending = active.pendingApprovals.get(requestId)
    if (!pending) return

    active.pendingApprovals.delete(requestId)

    // Send JSON-RPC response back to codex
    this.writeMessage(active, {
      jsonrpc: '2.0',
      id: pending.jsonRpcId,
      result: { decision },
    })

    active.onEvent({
      type: 'request.closed',
      threadId,
      requestId,
      decision,
    })
  }

  async setRuntimeMode(threadId: string, mode: import('../types').RuntimeMode): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    active.session.runtimeMode = mode
    // Codex app-server takes permission policy per turn; mid-turn updates are not supported.
    // The new value will apply on the next turn/start.
    log.info(`runtime mode stored for next turn: ${threadId} → ${mode}`)
  }

  async answerQuestion(threadId: string, requestId: string, answers: string[][]): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.child) return

    const pending = active.pendingApprovals.get(requestId)
    if (!pending) return
    active.pendingApprovals.delete(requestId)

    // Respond to the server's original userInput request with the answers.
    this.writeMessage(active, {
      jsonrpc: '2.0',
      id: pending.jsonRpcId,
      result: { answers },
    })

    active.onEvent({ type: 'question.answered', threadId, requestId, answers })
  }

  async stopSession(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return

    if (active.child) {
      active.child.kill('SIGTERM')
      active.child = null
    }

    // Reject pending RPCs
    for (const [, pending] of active.pendingRpcs) {
      pending.reject(new Error('Session stopped'))
    }

    this.sessions.delete(threadId)
    log.info(`session stopped: ${threadId}`)
  }

  // ── JSON-RPC Helpers ─────────────────────────────────────────

  private sendRpc(active: ActiveSession, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!active.child?.stdin?.writable) {
        reject(new Error('Process not connected'))
        return
      }

      const id = active.nextRpcId++
      active.pendingRpcs.set(id, { resolve, reject })

      this.writeMessage(active, {
        jsonrpc: '2.0',
        id,
        method,
        params,
      })
    })
  }

  private writeMessage(active: ActiveSession, msg: unknown): void {
    if (!active.child?.stdin?.writable) return
    const line = JSON.stringify(msg)
    log.debug(`codex <- ${truncateLogPayload(line)}`)
    active.child.stdin.write(line + '\n')
  }

  private sendNotification(active: ActiveSession, method: string, params?: unknown): void {
    this.writeMessage(active, {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    })
  }

  private handleMessage(threadId: string, active: ActiveSession, parsed: any): void {
    // JSON-RPC response (has id + result/error)
    if (parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined)) {
      log.debug(`codex response id=${parsed.id} ${parsed.error ? `error=${parsed.error.message}` : 'ok'}`)
      const pending = active.pendingRpcs.get(parsed.id)
      if (pending) {
        active.pendingRpcs.delete(parsed.id)
        if (parsed.error) {
          pending.reject(new Error(parsed.error.message || 'RPC error'))
        } else {
          pending.resolve(parsed.result)
        }
      }
      if (!pending) {
        log.debug(`codex response had no pending RPC: id=${parsed.id}`)
      }
      return
    }

    // JSON-RPC request from server (approval requests)
    if (parsed.id !== undefined && parsed.method) {
      log.debug(`codex server request: ${parsed.method} id=${parsed.id}`)
      this.handleServerRequest(threadId, active, parsed)
      return
    }

    // JSON-RPC notification (stream events)
    if (parsed.method) {
      log.debug(`codex notification: ${parsed.method}`)
      this.handleNotification(threadId, active, parsed)
      return
    }

    log.debug(`codex ignored message without id/method: ${truncateLogPayload(JSON.stringify(parsed))}`)
  }

  private handleServerRequest(threadId: string, active: ActiveSession, request: any): void {
    const method = request.method as string

    if (method.includes('requestApproval')) {
      // Derive a tool name from the approval request shape so our policy
      // can evaluate it against the active runtime mode.
      const toolName: string = method.includes('commandExecution')
        ? 'shell'
        : (request.params?.toolName ?? request.params?.path ?? 'tool')
      const requestType = method.includes('commandExecution') ? 'command' as const : 'file' as const
      const currentMode = active.session.runtimeMode
      const policy = decidePermission(currentMode, toolName)

      // Fast-path: policy has a definitive answer — respond immediately
      // without bothering the user. This is how plan mode's hard-deny,
      // accept-edits' auto-allow, and full-access work on the Codex side.
      if (policy === 'allow') {
        this.writeMessage(active, {
          jsonrpc: '2.0',
          id: request.id,
          result: { decision: 'approve' },
        })
        return
      }
      if (policy === 'deny') {
        // Emit tool.denied so the UI pill renders (parity with Claude).
        active.onEvent({
          type: 'tool.denied',
          threadId,
          toolName,
          reason: denialMessage(currentMode, toolName),
          mode: currentMode,
        })
        this.writeMessage(active, {
          jsonrpc: '2.0',
          id: request.id,
          result: { decision: 'deny' },
        })
        return
      }

      // policy === 'prompt' — bubble the approval UI up to the user.
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      active.pendingApprovals.set(requestId, {
        jsonRpcId: request.id,
        requestId,
      })

      active.onEvent({
        type: 'request.opened',
        threadId,
        requestId,
        requestType,
        toolName,
        detail: JSON.stringify(request.params ?? {}, null, 2).slice(0, 500),
      })
      return
    }

    // AskUserQuestion equivalent — Codex may surface interactive questions
    // under a different method name. If observed, route through the same
    // question.asked flow so QuestionCard renders for Codex too.
    if (method === 'item/userInput/request' || method === 'askUserQuestion') {
      const requestId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const params = request.params ?? {}
      const questions = Array.isArray(params.questions)
        ? params.questions
        : [{ question: params.prompt ?? params.question ?? 'Choose one', options: params.options ?? [] }]

      active.pendingApprovals.set(requestId, {
        jsonRpcId: request.id,
        requestId,
      })

      active.onEvent({
        type: 'question.asked',
        threadId,
        requestId,
        questions: questions.map((q: Record<string, unknown>, idx: number) => ({
          id: (q.id as string) ?? `q_${idx}`,
          header: (q.header as string) ?? `Question ${idx + 1}`,
          question: (q.question as string) ?? '',
          options: Array.isArray(q.options)
            ? q.options.map((o: Record<string, unknown>) => ({
                label: (o.label as string) ?? String(o),
                description: o.description as string | undefined,
              }))
            : [],
          multiSelect: Boolean(q.multiSelect),
        })),
      })
    }
  }

  private handleNotification(threadId: string, active: ActiveSession, notification: any): void {
    const method = notification.method as string
    log.debug(`handling codex notification ${method}: ${truncateLogPayload(JSON.stringify(notification.params ?? {}))}`)

    if (method === 'item/agentMessage/delta' || method.includes('delta')) {
      const text = notification.params?.delta
        || notification.params?.text
        || notification.params?.content
        || ''
      if (text) {
        const messageId = notification.params?.itemId ?? `msg_${Date.now()}`
        const fullText = notification.params?.delta
          ? `${active.assistantMessageText.get(messageId) ?? ''}${text}`
          : text
        active.assistantMessageText.set(messageId, fullText)

        active.onEvent({
          type: 'content',
          threadId,
          messageId,
          text: fullText,
          streamKind: 'assistant',
        })
      }
    } else if (method === 'error') {
      const message = notification.params?.error?.message
        ?? notification.params?.message
        ?? 'Codex reported an error'
      log.error(`codex error notification: ${message}`, notification.params ?? {})
      active.onEvent({
        type: 'error',
        threadId,
        message,
      })
      if (!notification.params?.willRetry) {
        active.session.status = 'error'
        active.onEvent({ type: 'status', threadId, status: 'error' })
      }
    } else if (method === 'turn/completed') {
      const turnStatus = notification.params?.turn?.status
      if (turnStatus === 'failed') {
        const message = notification.params?.turn?.error?.message ?? 'Codex turn failed'
        log.error(`codex turn failed: ${message}`, notification.params ?? {})
        active.session.status = 'error'
        active.onEvent({ type: 'error', threadId, message })
        active.onEvent({ type: 'status', threadId, status: 'error' })
      } else {
        active.session.status = 'idle'
        const durationMs =
          active.turnStartedAt != null ? Date.now() - active.turnStartedAt : undefined
        active.turnStartedAt = null
        active.onEvent({
          type: 'turn.completed',
          threadId,
          costUsd: notification.params?.totalCostUsd,
          numTurns: notification.params?.numTurns,
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
        active.onEvent({ type: 'status', threadId, status: 'idle' })
      }
    } else {
      log.debug(`unhandled codex notification: ${method}`)
    }
  }
}
