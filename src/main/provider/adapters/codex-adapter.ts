/**
 * Codex app-server adapter.
 *
 * Spawns `codex app-server` as a child process and communicates
 * via JSON-RPC 2.0 over newline-delimited JSON on stdio.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { accessSync, constants } from 'fs'
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
import { parseCodexTodoItems, parseCodexTodoMarkdown } from './codex-todo'
import { applyEnvOverlay } from '../env-overlay'
import type { ProviderSkill } from '@shared/types'
import { withTimeout } from '@shared/promise-timeout'
import { conversationSessionHints, resolveResumeSegment } from '../../db/database'
import { scanCodexSessionCopies } from '../../projects/session-scanner'
import { codexCandidateDirs } from '../codex-session-dirs'

/**
 * Map our runtime modes to Codex app-server approval policies.
 *
 * Codex's own policies:
 *   - `never`       -> auto-approve everything (our full-access)
 *   - `on-request`  → ask per tool (our sandbox)
 *   - `untrusted`   → deny non-read tools (our plan)
 *
 * Our policy still gates via decidePermission() for correctness - this
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
const MAX_TOOL_OUTPUT_CHARS = 256 * 1024

/**
 * Hard ceiling for the `initialize` JSON-RPC. If `codex app-server` is the
 * wrong binary, hung on auth, or otherwise silent, we want the user to see
 * an error in seconds - not when they happen to switch agents and the
 * pending RPC gets rejected by stopSession (which historically presented as
 * the cryptic "Init failed: Session stopped" hours after the fact).
 */
const INIT_TIMEOUT_MS = 30_000

/**
 * Window during which we collect stderr to attach to init failures. Anything
 * codex prints during startup (auth prompts, "command not found", protocol
 * mismatch warnings) is the most useful diagnostic and otherwise only ends
 * up in the file logger.
 */
const INIT_STDERR_CAPTURE_LIMIT = 2000

function truncateLogPayload(value: string): string {
  return value.length > LOG_PAYLOAD_LIMIT
    ? `${value.slice(0, LOG_PAYLOAD_LIMIT)}…<truncated ${value.length - LOG_PAYLOAD_LIMIT} chars>`
    : value
}

/**
 * Per-frame wire logging is off by default: the app-server streams one
 * JSON-RPC notification per delta during a turn, and logging each one wrote
 * a line to disk per token. Set SB_CODEX_WIRE_LOG=1 to debug the protocol.
 */
const WIRE_LOG = process.env.SB_CODEX_WIRE_LOG === '1'

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
  questionIds?: string[]
  mcpFields?: McpElicitationField[]
}

interface ToolOutputAccumulator {
  head: string
  tail: string
  totalChars: number
}

function appendToolOutput(
  current: ToolOutputAccumulator | undefined,
  delta: string,
): ToolOutputAccumulator {
  const half = MAX_TOOL_OUTPUT_CHARS / 2
  if (!current) {
    if (delta.length <= MAX_TOOL_OUTPUT_CHARS) {
      return { head: delta, tail: '', totalChars: delta.length }
    }
    return {
      head: delta.slice(0, half),
      tail: delta.slice(-half),
      totalChars: delta.length,
    }
  }

  const totalChars = current.totalChars + delta.length
  if (totalChars <= MAX_TOOL_OUTPUT_CHARS) {
    return { head: current.head + current.tail + delta, tail: '', totalChars }
  }
  const crossing = current.totalChars <= MAX_TOOL_OUTPUT_CHARS
  const combined = crossing ? current.head + current.tail + delta : current.tail + delta
  const head = crossing ? combined.slice(0, half) : current.head
  const tail = combined.slice(-half)
  return { head, tail, totalChars }
}

function boundedToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output
  const omitted = output.length - MAX_TOOL_OUTPUT_CHARS
  const marker = `\n…<truncated ${omitted.toLocaleString('en-US')} chars>…\n`
  const remaining = MAX_TOOL_OUTPUT_CHARS - marker.length
  const headChars = Math.ceil(remaining / 2)
  return `${output.slice(0, headChars)}${marker}${output.slice(-(remaining - headChars))}`
}

function accumulatedToolOutput(accumulator: ToolOutputAccumulator | undefined): string | undefined {
  if (!accumulator) return undefined
  if (accumulator.totalChars <= MAX_TOOL_OUTPUT_CHARS) {
    return accumulator.head + accumulator.tail
  }
  const marker = `\n…<truncated ${(accumulator.totalChars - MAX_TOOL_OUTPUT_CHARS).toLocaleString('en-US')} chars>…\n`
  const remaining = MAX_TOOL_OUTPUT_CHARS - marker.length
  const headChars = Math.ceil(remaining / 2)
  return `${accumulator.head.slice(0, headChars)}${marker}${accumulator.tail.slice(-(remaining - headChars))}`
}

interface McpElicitationField {
  id: string
  type: 'string' | 'boolean' | 'number' | 'integer' | 'array'
}

interface ActiveSession {
  session: ProviderSession
  child: ChildProcessWithoutNullStreams | null
  onEvent: (event: RuntimeEvent) => void
  nextRpcId: number
  pendingRpcs: Map<number, PendingRpc>
  pendingApprovals: Map<string, PendingApproval>
  assistantMessageText: Map<string, string>
  toolOutputText: Map<string, ToolOutputAccumulator>
  threadId: string | null
  /** Cached `skills/list` response. Populated on first listSkills() call. */
  skills: ProviderSkill[] | null
  models: Array<{ id: string; label: string; tier: 'fast' | 'balanced' | 'max' }> | null
  /** Wall-clock turn-start timestamp; null when no turn is in flight. */
  turnStartedAt: number | null
  /** Active codex turn id (from turn/start response or turn/started); null
   * when idle. Required as `expectedTurnId` to steer a running turn. */
  activeTurnId: string | null
  /** A turn/start RPC that has been sent but has not returned its turn id yet.
   * Follow-up sends wait for it so they steer instead of starting a second
   * provider turn in the response gap. */
  turnStartPromise: Promise<void> | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringifyMaybe(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function isMissingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /thread(?:\s+\S+)?\s+(?:is\s+)?not (?:found|loaded)\b|no rollout found\b/i.test(message)
}

function parseMcpForm(params: unknown): {
  fields: McpElicitationField[]
  questions: Array<{
    id: string
    header: string
    question: string
    options: Array<{ label: string }>
    multiSelect: boolean
  }>
} | null {
  const request = asRecord(params)
  const schema = asRecord(request?.requestedSchema)
  const properties = asRecord(schema?.properties)
  if (request?.mode !== 'form' || !properties) return null

  const fields: McpElicitationField[] = []
  const questions = Object.entries(properties).flatMap(([id, value]) => {
    const property = asRecord(value)
    if (!property) return []
    const type = property.type
    if (type !== 'string' && type !== 'boolean' && type !== 'number' && type !== 'integer' && type !== 'array') {
      return []
    }

    fields.push({ id, type })
    const enumValues = type === 'array'
      ? asRecord(property.items)?.enum
      : property.enum
    const labels = Array.isArray(enumValues)
      ? enumValues.map(String)
      : type === 'boolean' ? ['Yes', 'No'] : []

    return [{
      id,
      header: typeof property.title === 'string' ? property.title : id,
      question: typeof property.description === 'string'
        ? property.description
        : typeof request.message === 'string' ? request.message : id,
      options: labels.map((label) => ({ label })),
      multiSelect: type === 'array',
    }]
  })

  return fields.length > 0 ? { fields, questions } : null
}

function mcpFormContent(fields: McpElicitationField[], answers: string[][]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field, index) => {
    const values = answers[index] ?? []
    const first = values[0] ?? ''
    if (field.type === 'boolean') return [field.id, first.toLowerCase() === 'yes' || first === 'true']
    if (field.type === 'number' || field.type === 'integer') return [field.id, Number(first)]
    if (field.type === 'array') return [field.id, values]
    return [field.id, first]
  }))
}

function codexFileEdits(item: Record<string, unknown>): Array<{
  file_path: string
  move_path?: string
  old_string: string
  new_string: string
}> {
  if (!Array.isArray(item.changes)) return []
  return item.changes.flatMap((value) => {
    const change = asRecord(value)
    if (typeof change?.path !== 'string' || typeof change.diff !== 'string') return []
    const filePath = change.path
    const kind = asRecord(change.kind)
    const movePath = typeof kind?.move_path === 'string' ? kind.move_path : undefined
    const hunks: Array<{ oldLines: string[]; newLines: string[] }> = []
    let hunk: { oldLines: string[]; newLines: string[] } | null = null
    for (const line of change.diff.split('\n')) {
      if (line.startsWith('@@')) {
        hunk = { oldLines: [], newLines: [] }
        hunks.push(hunk)
        continue
      }
      if (!hunk || line === '\\ No newline at end of file') continue
      if (line.startsWith('-')) hunk.oldLines.push(line.slice(1))
      else if (line.startsWith('+')) hunk.newLines.push(line.slice(1))
      else if (line.startsWith(' ')) {
        hunk.oldLines.push(line.slice(1))
        hunk.newLines.push(line.slice(1))
      }
    }
    const edits = hunks.map(({ oldLines, newLines }) => ({
      file_path: filePath,
      ...(movePath ? { move_path: movePath } : {}),
      old_string: oldLines.join('\n'),
      new_string: newLines.join('\n'),
    }))
    if (edits.length > 0 || !movePath) return edits
    return [{ file_path: filePath, move_path: movePath, old_string: '', new_string: '' }]
  })
}

function codexFileChangeOutput(status: unknown): string {
  if (status === 'completed') return 'Applied'
  if (status === 'declined') return 'Declined'
  if (status === 'failed') return 'Failed'
  return 'Finished'
}

function codexModelTier(id: string): 'fast' | 'balanced' | 'max' {
  const normalized = id.toLowerCase()
  if (/mini|nano|flash|fast/.test(normalized)) return 'fast'
  if (/sol|pro|max|ultra/.test(normalized)) return 'max'
  return 'balanced'
}

export function parseCodexModels(input: unknown): Array<{ id: string; label: string; tier: 'fast' | 'balanced' | 'max' }> {
  const root = asRecord(input)
  const entries = Array.isArray(root?.data) ? root.data : []
  return entries.flatMap((entry) => {
    const model = asRecord(entry)
    const id = typeof model?.id === 'string'
      ? model.id
      : (typeof model?.model === 'string' ? model.model : null)
    if (!id || model?.hidden === true) return []
    return [{
      id,
      label: typeof model?.displayName === 'string' ? model.displayName : id,
      tier: codexModelTier(id),
    }]
  })
}

function codexToolName(item: Record<string, unknown>): string | null {
  const type = typeof item.type === 'string' ? item.type : ''
  if (type === 'commandExecution') return 'Bash'
  if (type === 'fileChange') return 'Edit'
  if (type === 'mcpToolCall') {
    const server = typeof item.server === 'string' ? item.server : 'MCP'
    const tool = typeof item.tool === 'string' ? item.tool : 'tool'
    return `${server}:${tool}`
  }
  if (type === 'dynamicToolCall') {
    return typeof item.tool === 'string' ? item.tool : 'Tool'
  }
  if (type === 'collabAgentToolCall') {
    return typeof item.tool === 'string' ? item.tool : 'Agent'
  }
  if (type === 'webSearch') return 'WebSearch'
  if (type === 'imageView') return 'Read'
  if (type === 'imageGeneration') return 'ImageGeneration'
  return null
}

function codexToolInput(item: Record<string, unknown>): unknown {
  const type = typeof item.type === 'string' ? item.type : ''
  if (type === 'commandExecution') {
    return {
      command: typeof item.command === 'string' ? item.command : '',
      ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
    }
  }
  if (type === 'fileChange') {
    return { changes: item.changes ?? [] }
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    return {
      ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
      ...(typeof item.namespace === 'string' ? { namespace: item.namespace } : {}),
      ...(typeof item.server === 'string' ? { server: item.server } : {}),
      ...(typeof item.tool === 'string' ? { tool: item.tool } : {}),
    }
  }
  if (type === 'collabAgentToolCall') {
    return {
      ...(typeof item.tool === 'string' ? { tool: item.tool } : {}),
      ...(typeof item.prompt === 'string' ? { prompt: item.prompt } : {}),
      ...(typeof item.model === 'string' ? { model: item.model } : {}),
    }
  }
  if (type === 'webSearch') {
    return { query: typeof item.query === 'string' ? item.query : '' }
  }
  if (type === 'imageView') {
    return { file_path: typeof item.path === 'string' ? item.path : '' }
  }
  return item
}

function codexToolOutput(item: Record<string, unknown>): string | undefined {
  const type = typeof item.type === 'string' ? item.type : ''
  if (type === 'commandExecution') return stringifyMaybe(item.aggregatedOutput)
  if (type === 'fileChange') return stringifyMaybe(item.changes)
  if (type === 'mcpToolCall') return stringifyMaybe(item.result ?? item.error)
  if (type === 'dynamicToolCall') return stringifyMaybe(item.contentItems)
  if (type === 'collabAgentToolCall') return stringifyMaybe(item.agentsStates)
  if (type === 'webSearch') return stringifyMaybe(item.action)
  if (type === 'imageGeneration') return stringifyMaybe(item.savedPath ?? item.result)
  return undefined
}

/**
 * Normalize Codex's `skills/list` response into ProviderSkill shape.
 * Codex's wire shape (per app-server v2): `{ skills: [{ name, description? }] }`.
 * Be defensive - accept top-level array too in case the schema shifts.
 */
export function parseCodexSkills(input: unknown): ProviderSkill[] {
  const root = asRecord(input)
  const grouped = Array.isArray(root?.data) ? root.data : null
  const arr = grouped
    ? grouped.flatMap((entry) => {
        const group = asRecord(entry)
        return Array.isArray(group?.skills) ? group.skills : []
      })
    : Array.isArray(input)
      ? input
      : Array.isArray(root?.skills)
        ? root.skills
        : []
  const out: ProviderSkill[] = []
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const rawName = typeof obj.name === 'string' ? obj.name : null
    if (!rawName) continue
    if (obj.enabled === false) continue
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
      ...(typeof obj.path === 'string' ? { path: obj.path } : {}),
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

export function findCodexPath(): string | null {
  const env = buildCodexCliEnv()
  const home = process.env.HOME || ''
  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    `${home}/.local/bin/codex`,
    `${home}/.npm-global/bin/codex`,
  ]

  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch { /* not found */ }
  }

  const whichOut = spawnSync('which', ['codex'], {
    env,
    timeout: 5000,
    encoding: 'utf-8',
  })
  if (whichOut.error || whichOut.status !== 0) return null
  const resolved = whichOut.stdout.trim().split('\n')[0]
  return resolved || null
}

/**
 * Finder-launched Electron apps miss shell-profile PATH additions. Build a
 * CLI-friendly env so codex can be discovered/spawned in packaged builds.
 */
export function buildCodexCliEnv(): Record<string, string> {
  const raw = { ...process.env }
  delete raw.ELECTRON_RUN_AS_NODE
  const home = raw.HOME || ''
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
  ].join(':')
  raw.PATH = `${extra}:${raw.PATH || '/usr/bin:/bin'}`
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) env[k] = v
  }
  return env
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
      instanceId: opts.instanceId,
    }
    const resumeThreadId = await this.resolveResumeThreadId(opts)
    if (resumeThreadId) session.sessionId = resumeThreadId

    const active: ActiveSession = {
      session,
      child: null,
      onEvent,
      nextRpcId: 1,
      pendingRpcs: new Map(),
      pendingApprovals: new Map(),
      assistantMessageText: new Map(),
      toolOutputText: new Map(),
      threadId: resumeThreadId,
      skills: null,
      models: null,
      turnStartedAt: null,
      activeTurnId: null,
      turnStartPromise: null,
    }

    this.sessions.set(opts.threadId, active)

    // CODEX_HOME points at a per-instance dir when auth_mode='oauth_dir',
    // letting each instance be `codex login`'d under a separate account.
    const codexEnv = buildCodexCliEnv()
    applyEnvOverlay(codexEnv, opts.resolvedEnv)
    if (opts.resolvedOauthDir && opts.resolvedOauthDir.length > 0) {
      codexEnv.CODEX_HOME = opts.resolvedOauthDir
    }

    // Spawn codex app-server
    const child = spawn(cachedCodexPath, ['app-server'], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: codexEnv,
    })

    active.child = child

    // Parse stdout as newline-delimited JSON
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      if (WIRE_LOG) log.debug(`codex -> ${truncateLogPayload(line)}`)
      try {
        const parsed = JSON.parse(line)
        this.handleMessage(opts.threadId, active, parsed)
      } catch {
        log.warn(`invalid JSON from codex: ${line.slice(0, 200)}`)
      }
    })

    // Capture early stderr so init failures can include codex's own
    // complaints (e.g. "please run `codex login`") in the user-facing
    // error message. Switched off once initialize() succeeds.
    let initStderrBuf = ''
    let captureInitStderr = true
    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString()
      log.warn(`codex stderr: ${truncateLogPayload(chunk)}`)
      if (captureInitStderr && initStderrBuf.length < INIT_STDERR_CAPTURE_LIMIT) {
        initStderrBuf = (initStderrBuf + chunk).slice(0, INIT_STDERR_CAPTURE_LIMIT)
      }
    })

    child.on('close', (code) => {
      log.info(`codex process exited: code=${code}`)
      active.child = null
      active.session.status = code === 0 ? 'stopped' : 'error'
      // Reject any in-flight RPCs so their awaiting callers don't hang forever
      // (and their promise/closure entries don't leak). Mirrors stopSession.
      for (const [, pending] of active.pendingRpcs) {
        pending.reject(new Error('Codex process exited'))
      }
      active.pendingRpcs.clear()
      onEvent({ type: 'status', threadId: opts.threadId, status: active.session.status })
    })

    child.on('error', (err) => {
      active.child = null
      active.session.status = 'error'
      onEvent({ type: 'error', threadId: opts.threadId, message: err.message })
      onEvent({ type: 'status', threadId: opts.threadId, status: 'error' })
    })

    // Send initialize RPC, bounded by INIT_TIMEOUT_MS. Without the bound, a
    // hung codex (wrong binary, waiting on stdin auth, etc.) would leave
    // this promise pending forever - the caller's `await startSession(...)`
    // would never return, the user would see no error, and a later
    // stopSession would finally reject the RPC with "Session stopped"
    // surfacing as a misleading "Init failed" much later. See CHANGELOG.
    try {
      await withTimeout(
        this.sendRpc(active, 'initialize', {
          clientInfo: SWITCHBOARD_CLIENT_INFO,
          capabilities: {
            experimentalApi: true,
          },
        }),
        INIT_TIMEOUT_MS,
        'initialize',
      )
      captureInitStderr = false
      this.sendNotification(active, 'initialized')
      if (resumeThreadId) {
        const approvalPolicy = RUNTIME_MODE_TO_CODEX_POLICY[session.runtimeMode] ?? 'on-request'
        const sandbox = RUNTIME_MODE_TO_CODEX_THREAD_SANDBOX[session.runtimeMode] ?? 'read-only'
        try {
          const resumed = await this.sendRpc(active, 'thread/resume', {
            threadId: resumeThreadId,
            cwd: session.cwd,
            approvalPolicy,
            sandbox,
            ...(session.model ? { model: session.model } : {}),
          })
          const result = resumed as { thread?: { id?: string } } | null
          const resumedId = result?.thread?.id ?? resumeThreadId
          active.threadId = resumedId
          session.sessionId = resumedId
          onEvent({ type: 'session', threadId: opts.threadId, sessionId: resumedId })
        } catch (err) {
          if (!isMissingThreadError(err)) throw err
          active.threadId = null
          session.sessionId = undefined
          onEvent({
            type: 'error',
            threadId: opts.threadId,
            message: `Could not resume Codex thread ${resumeThreadId}; the next turn will start a new thread. ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }
      active.session.status = 'idle'
      onEvent({ type: 'status', threadId: opts.threadId, status: 'idle' })
    } catch (err) {
      captureInitStderr = false
      active.session.status = 'error'
      const baseMessage = err instanceof Error ? err.message : String(err)
      const stderrTrail = initStderrBuf.trim()
      const message = stderrTrail
        ? `Init failed: ${baseMessage}\n\nCodex stderr:\n${stderrTrail}`
        : `Init failed: ${baseMessage}`
      // Tear down the child + registry entry so the next sendTurn doesn't
      // race on a half-initialized session.
      if (active.child) {
        try { active.child.kill('SIGTERM') } catch { /* already dead */ }
        active.child = null
      }
      this.sessions.delete(opts.threadId)
      onEvent({ type: 'error', threadId: opts.threadId, message })
      onEvent({ type: 'status', threadId: opts.threadId, status: 'error' })
      // Reject the caller's promise so ChatPanel.handleSend's catch fires
      // and clears its providerStartedRef - otherwise the ref stays in
      // the "started" set and subsequent sends silently no-op on the
      // session-init path.
      throw new Error(message)
    }

    log.info(`session started: ${opts.threadId}`)
    return session
  }

  private async resolveResumeThreadId(opts: SessionStartOpts): Promise<string | null> {
    try {
      const typed = resolveResumeSegment(opts.threadId, 'codex', opts.instanceId)
      if (typed) return typed.provider_session_id
    } catch {
      // Legacy databases or startup failures still have the old lineage path.
    }
    try {
      const candidates = [
        ...conversationSessionHints(opts.threadId).reverse(),
        ...(opts.resumeSessionId && opts.resumeSessionId !== opts.threadId ? [opts.resumeSessionId] : []),
      ]
      if (candidates.length === 0) return null
      const copies = await scanCodexSessionCopies(new Set(candidates), codexCandidateDirs())
      const available = new Set(copies.map((copy) => copy.id))
      return candidates.find((candidate) => available.has(candidate)) ?? null
    } catch {
      return null
    }
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

    // Build current Codex app-server v2 user input blocks.
    const content: Array<Record<string, unknown>> = []
    if (message) {
      const skillMention = message.match(/^\s*\$([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/)
      const skill = skillMention
        ? active.skills?.find((candidate) => candidate.name.toLowerCase() === skillMention[1].toLowerCase())
        : undefined
      if (skill?.path) {
        content.push({ type: 'skill', name: skill.name, path: skill.path })
        const instruction = skillMention?.[2]?.trim()
        if (instruction) content.push({ type: 'text', text: instruction })
      } else {
        content.push({ type: 'text', text: message })
      }
    }
    if (images && images.length > 0) {
      for (const img of images) {
        // Codex accepts data URLs directly - no need to strip the prefix.
        content.push({ type: 'image', url: img.url })
      }
    }

    // A follow-up can arrive after turn/start was sent but before its response
    // provides activeTurnId. Wait through that narrow gap, then take the steer
    // path below instead of accidentally opening a concurrent Codex turn.
    if (active.turnStartPromise) await active.turnStartPromise

    // Mid-turn send with a live turn id → steer it (inject into the running
    // turn) rather than starting a concurrent one. Only a fresh turn resets
    // status/timestamp; steering leaves the in-flight turn's clock alone.
    const activeTurnId = active.activeTurnId
    if (activeTurnId) {
      const steer = (expectedTurnId: string) => this.sendRpc(active, 'turn/steer', {
        threadId: active.threadId,
        input: content,
        expectedTurnId,
      })
      try {
        const steered = await steer(activeTurnId)
        // Track the (possibly advanced) turn id so a follow-up steer targets
        // the right turn.
        const steeredTurnId = (steered as { turnId?: string } | null)?.turnId
        if (typeof steeredTurnId === 'string') active.activeTurnId = steeredTurnId
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const liveTurnId = msg.match(/\bfound\s+([\w-]+)/i)?.[1]
        if (!liveTurnId) throw err

        log.warn(`codex turn id changed; retrying steer against ${liveTurnId}`)
        active.activeTurnId = liveTurnId
        const steered = await steer(liveTurnId)
        const steeredTurnId = (steered as { turnId?: string } | null)?.turnId
        if (typeof steeredTurnId === 'string') active.activeTurnId = steeredTurnId
        return
      }
    }

    active.session.status = 'running'
    active.turnStartedAt = Date.now()
    active.onEvent({ type: 'status', threadId, status: 'running' })

    const approvalPolicy = RUNTIME_MODE_TO_CODEX_POLICY[active.session.runtimeMode] ?? 'on-request'
    const reasoningEffort = active.session.reasoningEffort
    const sandbox = RUNTIME_MODE_TO_CODEX_THREAD_SANDBOX[active.session.runtimeMode] ?? 'read-only'
    const sandboxPolicy = RUNTIME_MODE_TO_CODEX_TURN_SANDBOX[active.session.runtimeMode] ?? { type: 'readOnly' }

    const ensureThread = async (): Promise<void> => {
      if (!active.threadId) {
        const result = await this.sendRpc(active, 'thread/start', {
          cwd: active.session.cwd,
          approvalPolicy,
          sandbox,
          ...(active.session.model ? { model: active.session.model } : {}),
        })
        const r = result as { thread?: { id?: string }; threadId?: string } | null | undefined
        active.threadId = r?.thread?.id ?? r?.threadId ?? null
        if (!active.threadId) {
          throw new Error('Codex thread/start did not return a thread id')
        }
        active.session.sessionId = active.threadId
        active.onEvent({ type: 'session', threadId, sessionId: active.threadId })
      }
    }

    const startTurn = async (): Promise<void> => {
      const started = await this.sendRpc(active, 'turn/start', {
        threadId: active.threadId,
        input: content,
        approvalPolicy,
        sandboxPolicy,
        cwd: active.session.cwd,
        ...(active.session.model ? { model: active.session.model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
      })
      const startedTurnId = (started as { turn?: { id?: string } } | null)?.turn?.id
      if (typeof startedTurnId === 'string') active.activeTurnId = startedTurnId
    }

    const startPromise = (async () => {
      try {
        await ensureThread()
        try {
          await startTurn()
        } catch (err) {
          if (!isMissingThreadError(err)) throw err
          log.warn(`codex thread disappeared, retrying turn on a fresh thread: ${err instanceof Error ? err.message : String(err)}`)
          active.threadId = null
          active.session.sessionId = undefined
          await ensureThread()
          await startTurn()
        }
      } catch (err) {
        active.session.status = 'idle'
        active.activeTurnId = null
        active.turnStartedAt = null
        active.onEvent({ type: 'status', threadId, status: 'idle' })
        throw err
      }
    })()
    active.turnStartPromise = startPromise
    try {
      await startPromise
    } finally {
      if (active.turnStartPromise === startPromise) active.turnStartPromise = null
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Only cache [] when the method is genuinely unsupported. Transient
      // startup/transport errors should keep retrying so skills can appear
      // once the app-server settles.
      const unsupported = /-32601|method not found|unknown method/i.test(message)
      if (unsupported) {
        log.warn(`skills/list unsupported by this codex build: ${message}`)
        active.skills = []
      } else {
        log.warn(`skills/list failed (will retry): ${message}`)
      }
      return []
    }
  }

  async listModels(threadId: string): Promise<Array<{ id: string; label: string; tier: 'fast' | 'balanced' | 'max' }>> {
    const active = this.sessions.get(threadId)
    if (!active?.child) return []
    if (active.models) return active.models
    try {
      const result = await this.sendRpc(active, 'model/list', { limit: 100, includeHidden: false })
      active.models = parseCodexModels(result)
      return active.models
    } catch (err) {
      log.warn(`model/list failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  async setModel(threadId: string, model: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    active.session.model = model
  }

  async interruptTurn(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.child || !active.threadId) return

    const turnId = active.activeTurnId
    if (!turnId) {
      active.session.status = 'idle'
      active.onEvent({ type: 'status', threadId, status: 'idle' })
      return
    }

    await withTimeout(
      this.sendRpc(active, 'turn/interrupt', { threadId: active.threadId, turnId }),
      5_000,
      'Codex turn interrupt',
    )
    active.activeTurnId = null
    active.turnStartedAt = null
    active.session.status = 'idle'
    active.onEvent({ type: 'status', threadId, status: 'idle' })
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

    const codexDecision = decision === 'approve' ? 'accept' : 'decline'
    // Send JSON-RPC response back to codex
    this.writeMessage(active, {
      jsonrpc: '2.0',
      id: pending.jsonRpcId,
      result: { decision: codexDecision },
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

    const result = pending.mcpFields
      ? {
          action: 'accept',
          content: mcpFormContent(pending.mcpFields, answers),
          _meta: null,
        }
      : pending.questionIds
      ? {
          answers: Object.fromEntries(
            pending.questionIds.map((id, index) => [id, { answers: answers[index] ?? [] }]),
          ),
        }
      : { answers }
    // Respond to the server's original userInput request with the answers.
    this.writeMessage(active, {
      jsonrpc: '2.0',
      id: pending.jsonRpcId,
      result,
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
    if (WIRE_LOG) log.debug(`codex <- ${truncateLogPayload(line)}`)
    active.child.stdin.write(line + '\n')
  }

  private sendNotification(active: ActiveSession, method: string, params?: unknown): void {
    this.writeMessage(active, {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    })
  }

  private handleItemLifecycle(threadId: string, active: ActiveSession, notification: { method: string; params?: unknown }): void {
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item) return

    const itemId = typeof item.id === 'string' ? item.id : (typeof params?.itemId === 'string' ? params.itemId : null)
    if (!itemId) return

    const itemType = typeof item.type === 'string' ? item.type : ''
    if (itemType === 'agentMessage') {
      const text = typeof item.text === 'string' ? item.text : ''
      if (text) {
        active.onEvent({
          type: 'content',
          threadId,
          messageId: itemId,
          text,
          streamKind: 'assistant',
        })
      }
      return
    }

    if (itemType === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary.filter((s): s is string => typeof s === 'string') : []
      const content = Array.isArray(item.content) ? item.content.filter((s): s is string => typeof s === 'string') : []
      const text = [...summary, ...content].join('\n').trim()
      if (text) {
        active.onEvent({
          type: 'content',
          threadId,
          messageId: itemId,
          text,
          streamKind: 'reasoning',
        })
      }
      return
    }

    // The same checklist arriving as a thread item, so it renders as one too.
    if (itemType === 'plan' && notification.method === 'item/completed') {
      // This shape carries the checklist as markdown text, not a plan array.
      const text = typeof item.text === 'string' ? item.text : ''
      const items = parseCodexTodoMarkdown(text)
      if (items.length > 0) {
        active.onEvent({ type: 'todo.updated', threadId, todoId: itemId, items })
      }
      return
    }

    if (itemType === 'contextCompaction') {
      active.onEvent({
        type: 'content',
        threadId,
        messageId: itemId,
        text: 'Context compacted.',
        streamKind: 'reasoning',
      })
      return
    }

    if (itemType === 'fileChange') {
      const edits = codexFileEdits(item)
      for (const [index, input] of edits.entries()) {
        const toolId = `${itemId}:${index}`
        if (notification.method === 'item/started' || notification.method === 'item/completed') {
          active.onEvent({ type: 'tool.started', threadId, toolId, toolName: 'Edit', input })
        }
        if (notification.method === 'item/completed') {
          active.onEvent({
            type: 'tool.completed',
            threadId,
            toolId,
            output: codexFileChangeOutput(item.status),
          })
        }
      }
      return
    }

    const toolName = codexToolName(item)
    if (!toolName) return

    if (notification.method === 'item/started') {
      active.onEvent({
        type: 'tool.started',
        threadId,
        toolId: itemId,
        toolName,
        input: codexToolInput(item),
      })
      return
    }

    if (notification.method === 'item/completed') {
      const completeOutput = codexToolOutput(item)
      const output = completeOutput !== undefined
        ? boundedToolOutput(completeOutput)
        : accumulatedToolOutput(active.toolOutputText.get(itemId))
      active.onEvent({
        type: 'tool.completed',
        threadId,
        toolId: itemId,
        output,
      })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON-RPC payload from codex app-server stdio; structure varies by message kind (response/request/notification) and is narrowed below
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
      if (WIRE_LOG) log.debug(`codex notification: ${parsed.method}`)
      this.handleNotification(threadId, active, parsed)
      return
    }

    log.debug(`codex ignored message without id/method: ${truncateLogPayload(JSON.stringify(parsed))}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON-RPC server request from codex app-server; loosely typed third-party wire format
  private handleServerRequest(threadId: string, active: ActiveSession, request: any): void {
    const method = request.method as string

    if (method === 'mcpServer/elicitation/request') {
      const form = parseMcpForm(request.params)
      if (!form) {
        this.writeMessage(active, {
          jsonrpc: '2.0',
          id: request.id,
          result: { action: 'cancel', content: null, _meta: null },
        })
        return
      }

      const requestId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      active.pendingApprovals.set(requestId, {
        jsonRpcId: request.id,
        requestId,
        mcpFields: form.fields,
      })
      active.onEvent({
        type: 'question.asked',
        threadId,
        requestId,
        questions: form.questions,
      })
      return
    }

    if (method.includes('requestApproval')) {
      // Derive a tool name from the approval request shape so our policy
      // can evaluate it against the active runtime mode.
      const toolName: string = method.includes('commandExecution')
        ? 'shell'
        : (request.params?.toolName ?? request.params?.path ?? 'tool')
      const requestType = method.includes('commandExecution') ? 'command' as const : 'file' as const
      const currentMode = active.session.runtimeMode
      const policy = decidePermission(currentMode, toolName)

      // Fast-path: policy has a definitive answer - respond immediately
      // without bothering the user. This is how plan mode's hard-deny,
      // accept-edits' auto-allow, and full-access work on the Codex side.
      if (policy === 'allow') {
        this.writeMessage(active, {
          jsonrpc: '2.0',
          id: request.id,
          result: { decision: 'accept' },
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
          result: { decision: 'decline' },
        })
        return
      }

      // policy === 'prompt' - bubble the approval UI up to the user.
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

    // AskUserQuestion equivalent - Codex may surface interactive questions
    // under a different method name. If observed, route through the same
    // question.asked flow so QuestionCard renders for Codex too.
    if (method === 'item/tool/requestUserInput' || method === 'item/userInput/request' || method === 'askUserQuestion') {
      const requestId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const params = request.params ?? {}
      const questions = Array.isArray(params.questions)
        ? params.questions
        : [{ question: params.prompt ?? params.question ?? 'Choose one', options: params.options ?? [] }]

      active.pendingApprovals.set(requestId, {
        jsonRpcId: request.id,
        requestId,
        ...(method === 'item/tool/requestUserInput'
          ? {
              questionIds: questions.map((q: Record<string, unknown>, idx: number) =>
                typeof q.id === 'string' ? q.id : `q_${idx}`,
              ),
            }
          : {}),
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON-RPC notification from codex app-server; method-dependent payload shape
  private handleNotification(threadId: string, active: ActiveSession, notification: any): void {
    const method = notification.method as string
    if (WIRE_LOG) log.debug(`handling codex notification ${method}: ${truncateLogPayload(JSON.stringify(notification.params ?? {}))}`)

    // App-server multiplexes foreground and delegated threads over one stdio
    // connection. A notification carrying a different native thread belongs
    // to a worker and must never mutate or render inside the logical parent.
    // Foreground identity is established only by correlated start/resume RPCs.
    const notificationParams = asRecord(notification.params) ?? {}
    const notificationThread = asRecord(notificationParams.thread) ?? {}
    const nativeThreadId = typeof notificationParams.threadId === 'string'
      ? notificationParams.threadId
      : typeof notificationThread.id === 'string'
        ? notificationThread.id
        : null
    if (method === 'thread/started' || (nativeThreadId && active.threadId && nativeThreadId !== active.threadId)) {
      return
    }

    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const text = notification.params?.delta ?? notification.params?.text ?? ''
      const messageId = notification.params?.itemId ?? `reason_${Date.now()}`
      if (text) {
        // Kept so a closing snapshot could be sent, and because the codex
        // wire mixes delta and whole-body forms for the same message id.
        active.assistantMessageText.set(messageId, `${active.assistantMessageText.get(messageId) ?? ''}${text}`)
        active.onEvent({
          type: 'content',
          threadId,
          messageId,
          text,
          append: true,
          streamKind: 'reasoning',
        })
      }
    } else if (method === 'item/plan/delta') {
      const text = notification.params?.delta ?? ''
      const messageId = notification.params?.itemId ?? `plan_${Date.now()}`
      if (text) {
        active.assistantMessageText.set(messageId, `${active.assistantMessageText.get(messageId) ?? ''}${text}`)
        active.onEvent({
          type: 'content',
          threadId,
          messageId,
          text,
          append: true,
          streamKind: 'plan',
        })
      }
    } else if (method === 'item/agentMessage/delta') {
      const text = notification.params?.delta
        || notification.params?.text
        || notification.params?.content
        || ''
      if (text) {
        const messageId = notification.params?.itemId ?? `msg_${Date.now()}`
        // `delta` is an increment; `text`/`content` are whole-body forms that
        // must still replace, so the wire mode follows which one arrived.
        const isDelta = Boolean(notification.params?.delta)
        active.assistantMessageText.set(
          messageId,
          isDelta ? `${active.assistantMessageText.get(messageId) ?? ''}${text}` : text,
        )

        active.onEvent({
          type: 'content',
          threadId,
          messageId,
          text,
          append: isDelta || undefined,
          streamKind: 'assistant',
        })
      }
    } else if (method === 'error') {
      const message = notification.params?.error?.message
        ?? notification.params?.message
        ?? 'Codex reported an error'
      const turnId = typeof notification.params?.turnId === 'string'
        ? notification.params.turnId
        : active.activeTurnId
      if (notification.params?.willRetry) {
        log.warn(`codex retry notification: ${message}`, notification.params ?? {})
        active.onEvent({
          type: 'turn.retrying',
          threadId,
          turnId: turnId ?? 'active',
          message,
        })
      } else {
        log.error(`codex error notification: ${message}`, notification.params ?? {})
        active.onEvent({
          type: 'error',
          threadId,
          message,
          ...(turnId ? { turnId } : {}),
        })
        active.session.status = 'error'
        active.onEvent({ type: 'status', threadId, status: 'error' })
      }
    } else if (method === 'turn/completed') {
      const turnStatus = notification.params?.turn?.status
      if (turnStatus === 'failed') {
        const message = notification.params?.turn?.error?.message ?? 'Codex turn failed'
        const turnId = notification.params?.turn?.id
        log.error(`codex turn failed: ${message}`, notification.params ?? {})
        active.session.status = 'error'
        active.onEvent({
          type: 'error',
          threadId,
          message,
          ...(typeof turnId === 'string' ? { turnId } : {}),
        })
        active.onEvent({ type: 'status', threadId, status: 'error' })
      } else {
        active.session.status = 'idle'
        const durationMs =
          active.turnStartedAt != null ? Date.now() - active.turnStartedAt : undefined
        active.turnStartedAt = null
        active.onEvent({
          type: 'turn.completed',
          threadId,
          ...(typeof notification.params?.turn?.id === 'string'
            ? { turnId: notification.params.turn.id }
            : {}),
          costUsd: notification.params?.totalCostUsd,
          numTurns: notification.params?.numTurns,
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
        active.onEvent({ type: 'status', threadId, status: 'idle' })
      }
      // Per-turn accumulators - all content is flushed to the renderer by now,
      // so drop it instead of growing these maps for the whole session (mirrors
      // the Claude/OpenCode adapters).
      active.assistantMessageText.clear()
      active.toolOutputText.clear()
      active.activeTurnId = null
    } else if (method === 'turn/started') {
      active.session.status = 'running'
      if (active.turnStartedAt == null) active.turnStartedAt = Date.now()
      const startedTurnId = notification.params?.turnId ?? notification.params?.turn?.id
      if (typeof startedTurnId === 'string') active.activeTurnId = startedTurnId
      active.onEvent({ type: 'status', threadId, status: 'running' })
    } else if (method === 'thread/status/changed') {
      const statusType = notification.params?.status?.type
      if (statusType === 'active') {
        active.session.status = 'running'
        active.onEvent({ type: 'status', threadId, status: 'running' })
      } else if (statusType === 'idle') {
        active.session.status = 'idle'
        active.onEvent({ type: 'status', threadId, status: 'idle' })
      } else if (statusType === 'error') {
        active.session.status = 'error'
        active.onEvent({ type: 'status', threadId, status: 'error' })
      }
    } else if (method === 'item/started' || method === 'item/completed') {
      this.handleItemLifecycle(threadId, active, notification)
    } else if (method === 'item/commandExecution/outputDelta') {
      const output = notification.params?.delta
      const toolId = notification.params?.itemId
      if (typeof toolId === 'string' && typeof output === 'string' && output) {
        active.toolOutputText.set(toolId, appendToolOutput(active.toolOutputText.get(toolId), output))
      }
    } else if (method === 'item/fileChange/patchUpdated') {
      const params = asRecord(notification.params)
      const itemId = typeof params?.itemId === 'string' ? params.itemId : null
      if (!itemId) return
      const edits = codexFileEdits({ changes: params?.changes })
      for (const [index, input] of edits.entries()) {
        active.onEvent({
          type: 'tool.started',
          threadId,
          toolId: `${itemId}:${index}`,
          toolName: 'Edit',
          input,
        })
      }
    } else if (method === 'item/fileChange/outputDelta' || method === 'turn/diff/updated') {
      return
    } else if (method === 'turn/plan/updated') {
      // `update_plan` is the model's own checklist, not a plan awaiting
      // approval: emitting `plan.proposed` drew Implement / Iterate buttons for
      // a decision nobody asked for. A real Codex plan is `exit_plan_mode`.
      const params = asRecord(notification.params)
      const items = parseCodexTodoItems(params)
      if (items.length > 0) {
        active.onEvent({
          type: 'todo.updated',
          threadId,
          todoId: typeof params?.turnId === 'string' ? params.turnId : `todo_${threadId}`,
          items,
        })
      }
    } else if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = notification.params?.tokenUsage
      const totalTokens = tokenUsage?.last?.totalTokens ?? tokenUsage?.total?.totalTokens
      const modelContextWindow = tokenUsage?.modelContextWindow
      if (typeof totalTokens === 'number') {
        active.onEvent({
          type: 'context_window',
          threadId,
          usedTokens: totalTokens,
          maxTokens: typeof modelContextWindow === 'number' ? modelContextWindow : null,
        })
      }
    } else if (
      method === 'account/rateLimits/updated'
      || method === 'remoteControl/status/changed'
      || method === 'mcpServer/startupStatus/updated'
    ) {
      // Telemetry-only notifications from newer codex builds.
      // Keep them out of "unhandled" logs to reduce noise.
      return
    } else {
      log.debug(`unhandled codex notification: ${method}`)
    }
  }
}
