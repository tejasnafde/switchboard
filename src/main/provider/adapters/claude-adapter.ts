/**
 * Claude Agent SDK adapter - streaming input mode.
 *
 * Uses @anthropic-ai/claude-agent-sdk's query() with an AsyncIterable prompt
 * so the session stays alive across turns. sendTurn pushes a new user message
 * into the queue; the SDK picks it up when the current turn completes (or
 * immediately if idle). Approval flow via canUseTool callback blocks on a
 * Promise until the user decides.
 */

import { execSync, execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import { promisify } from 'util'
import { createMainLogger as createLogger } from '../../logger'
import { recordThreadSession, listSessionIdsForThread } from '../../db/database'

/**
 * Claude Code CLI only accepts UUID session ids (or exact titles) for
 * --resume. Switchboard-native threads use `agent_<timestamp>` ids that
 * the CLI rejects. This regex lets us filter: if our stored resume id
 * looks like a UUID, pass it through; otherwise, fall back to looking up
 * Claude's assigned child session ids via thread_sessions.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve a valid Claude session id to resume against.
 *
 * Priority:
 *   1. If `hint` is already a UUID, use it.
 *   2. Otherwise, look up children of `threadId` recorded in
 *      `thread_sessions` (Claude SDK emits a `session` event on every
 *      new session_id it assigns - we persist those as children) and
 *      pick the most recent UUID.
 *   3. If nothing matches, return undefined → SDK starts a fresh session.
 */
function resolveClaudeResumeId(threadId: string, hint?: string): string | undefined {
  if (hint && UUID_RE.test(hint)) return hint
  try {
    const ids = listSessionIdsForThread(threadId)
    // listSessionIdsForThread returns [threadId, ...children] with children
    // ordered by recorded_at ASC. Walk end-to-start to get the most recent
    // UUID child; skip the threadId itself if it isn't a UUID.
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]
      if (UUID_RE.test(id)) return id
    }
  } catch { /* DB might not be ready yet - fine, we'll start fresh */ }
  return undefined
}
import type {
  ProviderAdapter,
  ProviderSession,
  SessionStartOpts,
  RuntimeEvent,
  RuntimeMode,
  ApprovalDecision,
} from '../types'
import type { ProviderSkill } from '@shared/types'
import { formatClaudeAuthStatus } from '@shared/provider-auth-format'
import { buildRateLimitMessage, classifyOverageScope, isOverageRejection } from '@shared/claude-rate-limit'
import { unixSecondsToMs } from '@shared/provider-usage'

const log = createLogger('provider:claude')

// SDK types - dynamic import at runtime
type SDKQuery = import('@anthropic-ai/claude-agent-sdk').Query
type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage
type SDKUserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage
type SDKOptions = import('@anthropic-ai/claude-agent-sdk').Options
type CanUseTool = import('@anthropic-ai/claude-agent-sdk').CanUseTool
type PermissionMode = import('@anthropic-ai/claude-agent-sdk').PermissionMode
type PermissionResult = import('@anthropic-ai/claude-agent-sdk').PermissionResult

/**
 * Build the env passed to the Claude SDK query, applying the per-instance
 * overlay and CLAUDE_CONFIG_DIR override. Exported for tests.
 */
export function buildClaudeQueryEnv(
  base: Record<string, string>,
  instanceEnv: Record<string, string>,
  instanceOauthDir: string | null,
): Record<string, string> {
  const env = { ...base }
  applyEnvOverlay(env, instanceEnv)
  if (instanceOauthDir && instanceOauthDir.length > 0) {
    env.CLAUDE_CONFIG_DIR = instanceOauthDir
  }
  return env
}

/**
 * Enrich an opaque "exited with code N" spawn failure with a sign-in hint.
 * Pure - the caller decides whether credentials are known-present (env API
 * key or an OAuth credentials file). When they are, the raw message stands:
 * a wrong hint ("not signed in") on a logged-in user's unrelated failure
 * would be worse than an opaque one. macOS Keychain-stored OAuth can't be
 * detected cheaply, hence the hedged "if you haven't signed in" phrasing.
 */
export function formatClaudeStartFailure(raw: string, credsKnownPresent: boolean): string {
  if (credsKnownPresent || !/exited with code/i.test(raw)) return raw
  return `${raw}. If you haven't signed in to Claude Code yet, run \`claude login\` in a terminal (or set ANTHROPIC_API_KEY on the provider instance), then retry.`
}

/**
 * True when credentials are provably present: an API key in the resolved
 * env, or an OAuth credentials file in the config dir. False means
 * "unknown" (macOS Keychain OAuth is invisible here), not "absent".
 */
function claudeCredsKnownPresent(env: Record<string, string>): boolean {
  if (env.ANTHROPIC_API_KEY) return true
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  try {
    return existsSync(join(configDir, '.credentials.json'))
  } catch {
    return false
  }
}

const execFileAsync = promisify(execFile)

/**
 * Preflight login state under the resolved CLAUDE_CONFIG_DIR before spawning a
 * session. `claude auth status` is a local credential read that prints JSON
 * (`loggedIn:false` when the profile is logged out). Spawning the real query
 * against a logged-out config dir hangs with no `system/init` and no error
 * (confirmed 2026-07-26), so we fail fast with the re-login command instead.
 * Fails OPEN: any probe error/timeout returns ok, so a possibly-valid session
 * is never blocked (a generic startup hang is a separate concern).
 */
async function probeClaudeLogin(
  bin: string,
  env: Record<string, string>,
  oauthDir: string | null,
): Promise<{ ok: boolean; message: string }> {
  try {
    const { stdout } = await execFileAsync(bin, ['auth', 'status'], {
      env,
      timeout: 7000,
      maxBuffer: 1024 * 1024,
    })
    return formatClaudeAuthStatus(stdout, oauthDir)
  } catch (err) {
    log.warn(`auth preflight probe failed, proceeding: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: true, message: '' }
  }
}

/** Build a clean env for Claude CLI/SDK (Electron strips PATH) */
export function buildClaudeCliEnv(): Record<string, string> {
  const raw = { ...process.env }
  delete raw.ELECTRON_RUN_AS_NODE
  const home = raw.HOME || ''
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.npm-global/bin`,
    `${home}/.local/bin`,
  ].join(':')
  raw.PATH = `${extra}:${raw.PATH || '/usr/bin:/bin'}`
  // Strip undefined values - SDK expects Record<string, string>
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) env[k] = v
  }
  return env
}

/** Find the claude binary - cached after first lookup */
let cachedClaudeBin: string | undefined
export function findClaudeBin(): string | undefined {
  if (cachedClaudeBin) return cachedClaudeBin
  const home = process.env.HOME || ''
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${home}/.claude/local/claude`,
    `${home}/.npm-global/bin/claude`,
  ]
  for (const p of candidates) {
    try { execSync(`test -x "${p}"`, { timeout: 2000 }); cachedClaudeBin = p; return p } catch {}
  }
  try {
    const which = execSync('which claude 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0]
    if (which) { cachedClaudeBin = which; return which }
  } catch { /* no global claude - fall through to the SDK-bundled binary */ }
  // Remote VMs have no global `claude`; the SDK ships its CLI as a per-platform
  // package. Resolve it ourselves and prefer the glibc variant - node's
  // detect-libc misfires to musl on some builds (e.g. a node whose process
  // report omits glibcVersionRuntime), so the SDK's own self-resolution picks
  // the wrong binary. Passing this as pathToClaudeCodeExecutable skips that.
  const sdkBin = findSdkClaudeBin()
  if (sdkBin) { cachedClaudeBin = sdkBin; return sdkBin }
  return undefined
}

/** Locate the SDK's bundled `claude` binary for this platform/arch (glibc-first on linux). */
function findSdkClaudeBin(): string | undefined {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const variants = process.platform === 'linux' ? [`linux-${arch}`, `linux-${arch}-musl`] : [`${process.platform}-${arch}`]
  // Candidate `@anthropic-ai` dirs: the bundled server's index.cjs sits next to
  // node_modules on the VM (__dirname); plus wherever the SDK main resolves from
  // (the SDK's exports map blocks resolving ./package.json, so use the main entry).
  const bases = [join(__dirname, 'node_modules', '@anthropic-ai')]
  try {
    const main = require.resolve('@anthropic-ai/claude-agent-sdk')
    const marker = `${sep}@anthropic-ai${sep}`
    const i = main.lastIndexOf(marker)
    if (i >= 0) bases.push(main.slice(0, i + marker.length - 1))
  } catch { /* not resolvable - the __dirname base still covers the VM */ }
  for (const base of bases) {
    for (const v of variants) {
      const p = join(base, `claude-agent-sdk-${v}`, bin)
      try {
        execSync(`test -f "${p}"`, { timeout: 2000 })
        try { execSync(`chmod +x "${p}"`, { timeout: 2000 }) } catch { /* may already be +x */ }
        return p
      } catch { /* variant not installed - try next */ }
    }
  }
  return undefined
}

const RUNTIME_MODE_TO_PERMISSION: Record<RuntimeMode, PermissionMode> = {
  'plan': 'plan',
  'sandbox': 'default',
  'accept-edits': 'acceptEdits',
  'full-access': 'bypassPermissions',
}

// Policy moved to `src/main/provider/policy.ts` so both adapters share it.
// Re-exported here for backward compat with existing imports + tests.
export {
  PLAN_READ_ONLY_TOOLS,
  CUSTOM_UI_TOOLS,
  decidePermission,
  denialMessage,
  type PermissionDecision,
} from '../policy'
import { decidePermission, CUSTOM_UI_TOOLS, denialMessage, notebookWriteRedirect } from '../policy'
import { notebookManager } from '../../notebooks/manager'
import { applyEnvOverlay } from '../env-overlay'
import {
  migrateClaudeSession,
  migrateClaudeSessionFromCandidates,
  claudeSessionExistsIn,
  defaultClaudeDir,
} from '../claude-session-migrate'
import { shapeQuestionAnswers } from './question-answers'
import { TurnWatchdog, StderrTail, countToolBrackets } from '../turn-watchdog'

/**
 * Silence this long inside a turn is reported to the UI. Generous because
 * long tool runs are legitimately quiet, but a spinner that never explains
 * itself is worse than a false alarm.
 */
const TURN_STALL_MS = 180_000
const STALL_CHECK_INTERVAL_MS = 20_000
const STDERR_TAIL_CHARS = 2_000

// ─── Prompt queue - push new SDKUserMessages into a running query ──

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = []
  private waiting: Array<(result: IteratorResult<SDKUserMessage>) => void> = []
  private closed = false

  push(message: SDKUserMessage): void {
    if (this.closed) return
    const waiter = this.waiting.shift()
    if (waiter) {
      waiter({ value: message, done: false })
    } else {
      this.buffer.push(message)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!
      waiter({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const next = this.buffer.shift()
        if (next) return Promise.resolve({ value: next, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => { this.waiting.push(resolve) })
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.closed = true
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}

// ─── Slash-command parsing ──────────────────────────────────────────

/**
 * Normalize the SDK's slash-command announcement into our ProviderSkill
 * shape. Accepts either:
 *   - string[]                       (older builds: `slash_commands`)
 *   - { name, description?, argumentHint? }[]  (newer: `commands`)
 *
 * Anything else is filtered out. Names with leading "/" get stripped so
 * the menu can render them uniformly.
 */
/**
 * Tool results out of an SDK `user` message.
 *
 * The SDK reports a finished tool as a tool_result block on a synthetic user
 * message. Nothing consumed those, so `tool.completed` was never emitted for
 * Claude at all - Codex and OpenCode both emit it - and any client keying a
 * spinner on completion span every tool card until the whole turn ended.
 *
 * `content` is a string for simple results and a block array for rich ones.
 */
export function extractToolResults(
  message: unknown,
): Array<{ toolId: string; output: string; isError: boolean }> {
  const blocks = (message as { message?: { content?: unknown } } | null)?.message?.content
  if (!Array.isArray(blocks)) return []
  const out: Array<{ toolId: string; output: string; isError: boolean }> = []
  for (const raw of blocks) {
    const block = raw as {
      type?: string
      tool_use_id?: string
      is_error?: boolean
      content?: unknown
    }
    if (block.type !== 'tool_result' || !block.tool_use_id) continue
    let text = ''
    if (typeof block.content === 'string') {
      text = block.content
    } else if (Array.isArray(block.content)) {
      text = block.content
        .map((c) => (c as { type?: string; text?: string }).text ?? '')
        .filter(Boolean)
        .join('\n')
    }
    out.push({ toolId: block.tool_use_id, output: text, isError: block.is_error === true })
  }
  return out
}

export function parseClaudeSlashCommands(input: unknown): ProviderSkill[] {
  if (!Array.isArray(input)) return []
  const out: ProviderSkill[] = []
  for (const entry of input) {
    if (typeof entry === 'string') {
      const name = entry.replace(/^\//, '').trim()
      if (name) out.push({ name, source: 'claude-code' })
      continue
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>
      const rawName = typeof obj.name === 'string' ? obj.name : null
      if (!rawName) continue
      const name = rawName.replace(/^\//, '').trim()
      if (!name) continue
      const description = typeof obj.description === 'string' ? obj.description : undefined
      const argumentHint = typeof obj.argumentHint === 'string'
        ? obj.argumentHint
        : (typeof obj.argument_hint === 'string' ? obj.argument_hint : undefined)
      out.push({
        name,
        ...(description ? { description } : {}),
        ...(argumentHint ? { argumentHint } : {}),
        source: 'claude-code',
      })
    }
  }
  // Dedupe by name (case-insensitive); keep first
  const seen = new Set<string>()
  return out.filter((s) => {
    const k = s.name.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Infer a picker tier from a Claude model id. Pure - exported for tests.
 * Unknown families default to 'balanced' so new models still render.
 */
export function inferTier(modelId: string): 'fast' | 'balanced' | 'max' {
  const id = modelId.toLowerCase()
  if (id.includes('haiku') || id.includes('mini')) return 'fast'
  if (id.includes('opus') || id.includes('fable')) return 'max'
  return 'balanced'
}

// ─── Pending approval + session state ───────────────────────────────

interface PendingApproval {
  requestId: string
  resolve: (decision: ApprovalDecision) => void
}

interface PendingQuestion {
  requestId: string
  resolve: (answers: string[][]) => void
}

interface ActiveSession {
  session: ProviderSession
  query: SDKQuery | null
  prompt: PromptQueue
  onEvent: (event: RuntimeEvent) => void
  abortController: AbortController
  pendingApprovals: Map<string, PendingApproval>
  pendingQuestions: Map<string, PendingQuestion>
  currentMessageId: string | null
  currentReasoningMessageId: string | null
  partialMessageText: Map<string, string>
  /** Whether the SDK is already draining the query iterator (only set once) */
  draining: boolean
  /**
   * Wall-clock timestamp (ms) when the most recent user message was pushed.
   * Read on `turn.completed` to compute `durationMs`. Reset to null after
   * each completion so a stale value can't leak into a follow-up turn that
   * the user hasn't sent yet.
   */
  turnStartedAt: number | null
  /**
   * Effective model id from the last `getContextUsage()` poll, e.g.
   * `claude-fable-5`. The rejection payload never carries the model, yet the
   * model is usually the cause - see docs/notes/rate-limit-debugging.md.
   */
  lastKnownModel: string | null
  /**
   * Slash commands the SDK exposes for this session - captured from the
   * `system/init` event's `slash_commands` field. Surfaced to the renderer
   * via `listSkills()` so the chat-input slash menu can include
   * Claude-defined commands (`/commit`, `/explain`, user-defined `.claude/commands/*`).
   */
  skills: ProviderSkill[]
  /**
   * Models the SDK reports as available - fetched from the live query's
   * `supportedModels()` in `listModels()` and cached here so callers get
   * the last-known list even while no query is running.
   */
  models: Array<{ id: string; label: string; tier: 'fast' | 'balanced' | 'max' }>
  /** Per-instance env overlay resolved by the registry, merged on top of `buildClaudeCliEnv()`. */
  instanceEnv: Record<string, string>
  /** Per-instance CLAUDE_CONFIG_DIR (set when auth_mode='oauth_dir'). */
  instanceOauthDir: string | null
  /** Reports turns that go silent with no terminal event (see TURN_STALL_MS). */
  watchdog: TurnWatchdog
  /** Rolling tail of the claude subprocess's stderr, attached to stall/error messages. */
  stderrTail: StderrTail
}

export class ClaudeAdapter implements ProviderAdapter {
  /** Drives every session's TurnWatchdog; unref'd so it never holds the process open. */
  private stallTimer: ReturnType<typeof setInterval> | null = null

  private ensureStallTimer(): void {
    if (this.stallTimer) return
    this.stallTimer = setInterval(() => {
      for (const active of this.sessions.values()) {
        active.watchdog.check(Date.now())
      }
    }, STALL_CHECK_INTERVAL_MS)
    this.stallTimer.unref?.()
  }

  readonly provider = 'claude' as const
  private sessions = new Map<string, ActiveSession>()
  /**
   * Last-known CLAUDE_CONFIG_DIR per thread. Used by `startSession` to
   * detect oauth_dir rotation and migrate the session JSONL across
   * profiles before resume so context is preserved. `null` means the
   * thread last ran under the default `~/.claude` (env mode).
   */
  private lastOauthDir = new Map<string, string | null>()

  async isAvailable(): Promise<boolean> {
    try {
      await import('@anthropic-ai/claude-agent-sdk')
      return true
    } catch {
      return false
    }
  }

  async startSession(
    opts: SessionStartOpts,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<ProviderSession> {
    // Resolve to a Claude-valid UUID (or undefined → fresh session).
    // Switchboard-native thread ids like `agent_<timestamp>` fail `--resume`
    // with "not a UUID and does not match any session title." Children
    // recorded in `thread_sessions` (Claude SDK-assigned UUIDs) are the
    // right resume target for any thread that's had at least one turn.
    let resumeId = resolveClaudeResumeId(opts.threadId, opts.resumeSessionId)
    if (opts.resumeSessionId && !resumeId) {
      log.info(`resume: no valid UUID for thread ${opts.threadId} (hint=${opts.resumeSessionId}) - starting fresh`)
    }

    // Detect oauth_dir rotation. If the previous startSession ran under a
    // different CLAUDE_CONFIG_DIR, the session JSONL lives in that profile,
    // not the new one - the SDK's resume call would throw "No conversation
    // found with session ID". Copy the JSONL across so resume succeeds and
    // turn-by-turn context is preserved.
    const newOauthDir = opts.resolvedOauthDir ?? null
    const newDirResolved = newOauthDir ?? defaultClaudeDir()
    const prevOauthDir = this.lastOauthDir.get(opts.threadId)
    if (resumeId) {
      let migrateResult: ReturnType<typeof migrateClaudeSession> | null = null
      if (prevOauthDir !== undefined && prevOauthDir !== newOauthDir) {
        // Hot path: in-memory tracker knows the previous dir (rotation
        // within the same app session).
        migrateResult = migrateClaudeSession({
          sessionId: resumeId,
          cwd: opts.cwd,
          fromDir: prevOauthDir ?? defaultClaudeDir(),
          toDir: newDirResolved,
        })
      } else if (prevOauthDir === undefined && !claudeSessionExistsIn(newDirResolved, resumeId, opts.cwd)) {
        // Cold path: first startSession on this thread since boot, and
        // the JSONL isn't where we'd expect. Scan every known oauth_dir
        // (default + each enabled instance's dir) to discover where the
        // session actually lives.
        const candidates = opts.candidateOauthDirs ?? [defaultClaudeDir()]
        migrateResult = migrateClaudeSessionFromCandidates({
          sessionId: resumeId,
          cwd: opts.cwd,
          toDir: newDirResolved,
          candidates,
        })
        if (migrateResult.ok && migrateResult.copied) {
          log.info(`cold-start migrate: copied from ${migrateResult.from}`)
        }
      }
      if (migrateResult && !migrateResult.ok) {
        log.warn(`session migrate failed (${migrateResult.reason}) - starting fresh`)
        onEvent({
          type: 'content',
          threadId: opts.threadId,
          messageId: `sys_migrate_${Date.now()}`,
          text:
            migrateResult.reason === 'source-missing'
              ? '(Couldn\'t migrate session history across profiles - original JSONL is gone. Starting fresh under the new instance.)'
              : `(Couldn't migrate session history: ${migrateResult.detail}. Starting fresh.)`,
          streamKind: 'reasoning',
        })
        resumeId = undefined
      }
    }
    this.lastOauthDir.set(opts.threadId, newOauthDir)

    const session: ProviderSession = {
      threadId: opts.threadId,
      provider: 'claude',
      status: 'idle',
      model: opts.model,
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      sessionId: resumeId,
      createdAt: Date.now(),
      instanceId: opts.instanceId,
    }

    const stderrTail = new StderrTail(STDERR_TAIL_CHARS)
    const watchdog = new TurnWatchdog(TURN_STALL_MS, (idleMs) => {
      const idleMin = Math.round(idleMs / 60_000)
      const tail = stderrTail.tail().trim()
      log.warn(`turn stalled: ${opts.threadId} no SDK events for ${Math.round(idleMs / 1000)}s`)
      onEvent({
        type: 'error',
        threadId: opts.threadId,
        message:
          `No response from Claude for ${idleMin} minute${idleMin === 1 ? '' : 's'}. ` +
          'It may still be working on a long operation. If it seems stuck, press Stop and resend.' +
          (tail ? `\n\nRecent claude stderr:\n${tail}` : ''),
      })
    })

    const active: ActiveSession = {
      session,
      query: null,
      prompt: new PromptQueue(),
      onEvent,
      abortController: new AbortController(),
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      currentMessageId: null,
      currentReasoningMessageId: null,
      partialMessageText: new Map(),
      draining: false,
      skills: [],
      models: [],
      turnStartedAt: null,
      lastKnownModel: null,
      instanceEnv: opts.resolvedEnv ?? {},
      instanceOauthDir: opts.resolvedOauthDir ?? null,
      watchdog,
      stderrTail,
    }

    this.sessions.set(opts.threadId, active)
    this.ensureStallTimer()
    onEvent({ type: 'status', threadId: opts.threadId, status: 'idle' })
    log.info(`session started: ${opts.threadId} cwd=${opts.cwd}`)
    return session
  }

  async sendTurn(
    threadId: string,
    message: string,
    runtimeMode?: RuntimeMode,
    images?: Array<{ url: string; mimeType?: string }>,
  ): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) throw new Error(`Session ${threadId} not found`)

    // Update session mode if overridden
    if (runtimeMode && runtimeMode !== active.session.runtimeMode) {
      active.session.runtimeMode = runtimeMode
      if (active.query) {
        try {
          await active.query.setPermissionMode(RUNTIME_MODE_TO_PERMISSION[runtimeMode])
        } catch { /* ignore - best-effort */ }
      }
    }

    // Immediately show "running" in UI - don't wait for SDK import + query startup
    if (active.session.status !== 'running') {
      active.session.status = 'running'
      active.onEvent({ type: 'status', threadId, status: 'running' })
    }

    // Build SDK content - text + optional image blocks
    let content: string | Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>
    if (images && images.length > 0) {
      const blocks: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = []
      for (const img of images) {
        // data URL → raw base64 (strip "data:image/png;base64," prefix)
        const match = img.url.match(/^data:(image\/\w+);base64,(.+)$/)
        if (match) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: match[1],
              data: match[2],
            },
          })
        }
      }
      if (message) {
        blocks.push({ type: 'text', text: message })
      }
      content = blocks.length > 0 ? blocks : message
    } else {
      content = message
    }

    // Push the message into the prompt queue - must match SDKUserMessage shape:
    // { type: 'user', message: MessageParam, parent_tool_use_id: string | null }
    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as SDKUserMessage
    active.prompt.push(userMsg)
    // Stamp wall-clock turn start now (not when SDK actually picks it up).
    // The user-perceived "Worked for X" should include any queueing delay
    // - that's the experience they're judging.
    active.turnStartedAt = Date.now()
    active.watchdog.turnStarted(Date.now())

    // If we haven't started the SDK query yet, kick it off now
    if (!active.draining) {
      active.draining = true
      this.startDraining(threadId, active).catch((err) => {
        log.error(`drain failed: ${threadId}`, err)
      })
    }
  }

  /**
   * Start the long-running query + drain its message stream.
   * Runs once per session - subsequent sendTurn calls just push to the queue.
   */
  private async startDraining(threadId: string, active: ActiveSession): Promise<void> {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const mode = active.session.runtimeMode
    const permissionMode = RUNTIME_MODE_TO_PERMISSION[mode]

    const canUseTool: CanUseTool = async (toolName, toolInput) => {
      // ── Special: ExitPlanMode ────────────────────────────────
      // The agent produced a plan while in Plan mode and wants to exit.
      // We capture the plan and surface it as a proposed plan for user review.
      // Then deny the tool so the agent stops here and waits for user feedback.
      if (toolName === 'ExitPlanMode') {
        const planMarkdown = extractPlanMarkdown(toolInput)
        if (planMarkdown) {
          const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
          active.onEvent({
            type: 'plan.proposed',
            threadId,
            planId,
            planMarkdown,
          })
          log.info(`plan proposed: ${threadId} planId=${planId} length=${planMarkdown.length}`)
        }
        return {
          behavior: 'deny',
          message: 'The client captured your proposed plan. Stop here and wait for the user\'s feedback or implementation request in a later turn.',
        } as PermissionResult
      }

      // ── Special: AskUserQuestion ─────────────────────────────
      // The agent wants the user to pick from options. We emit a question
      // event, block until the user answers, then return the answers as
      // the tool's input so the SDK's own tool shortcircuits with those
      // values (rather than trying to prompt interactively itself).
      //
      // Previous bug: we set `__user_answers` on updatedInput - the SDK's
      // AskUserQuestion tool doesn't know that field, so it fell back to
      // its default (first option). T3 Code uses the same pattern as us
      // here: return `allow` + updatedInput that contains a top-level
      // `answers` object keyed by question id. The SDK tool picks that
      // up and returns it as-is.
      if (toolName === 'AskUserQuestion') {
        const questions = parseQuestions(toolInput)
        if (questions.length > 0) {
          const requestId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
          log.info(`question asked: ${threadId} requestId=${requestId} count=${questions.length}`)
          active.onEvent({
            type: 'question.asked',
            threadId,
            requestId,
            questions,
          })
          // Waiting on the user - expected silence, hold stall reports.
          active.watchdog.suspend()
          const userAnswers = await new Promise<string[][]>((resolve) => {
            active.pendingQuestions.set(requestId, { requestId, resolve })
          })
          active.watchdog.resume(Date.now())
          active.onEvent({ type: 'question.answered', threadId, requestId, answers: userAnswers })

          // Shape into the SDK's wire contract: answers keyed by question
          // *text* (not header/id), multi-select joined as comma-space string.
          // See `question-answers.ts` for the regression that motivated the
          // helper - keying by header silently dropped every answer.
          const shaped = shapeQuestionAnswers(questions, userAnswers)

          log.info(`question answered: ${threadId} requestId=${requestId} answers=${JSON.stringify(shaped.answers).slice(0, 300)}`)
          return {
            behavior: 'allow',
            updatedInput: {
              ...toolInput,
              ...shaped,
            },
          } as PermissionResult
        }
        log.warn(`AskUserQuestion: parseQuestions returned 0 - falling through to regular approval`)
      }

      const currentMode = active.session.runtimeMode
      const policy = decidePermission(currentMode, toolName)

      if (policy === 'deny') {
        const reason = denialMessage(currentMode, toolName)
        // Emit a UI-facing event so the renderer can show a denial pill in
        // the chat stream. Without this, the user only sees the agent's next
        // prose reaction to the denial - no visible policy-level signal.
        active.onEvent({
          type: 'tool.denied',
          threadId,
          toolName,
          reason,
          mode: currentMode,
        })
        return {
          behavior: 'deny',
          message: reason,
        } as PermissionResult
      }
      // ── Notebook guardrail ───────────────────────────────────
      // Writes that would otherwise proceed (allow or prompt) never touch
      // .ipynb JSON - the denial names the .py mirror so the agent
      // self-corrects, and the mirror is created on demand so the very next
      // tool call can succeed. Runs after the mode policy so plan mode's
      // blanket denial keeps precedence. Paths resolve against the repo
      // root the notebook manager attached at (the git toplevel), not the
      // session cwd, so subdir-rooted sessions get correct mirror paths.
      const notebookRoot = notebookManager.rootFor(threadId) ?? active.session.cwd
      const redirect = notebookWriteRedirect(toolName, toolInput, notebookRoot)
      if (redirect) {
        if (redirect.notebookRelPath) notebookManager.ensureMirrorFor(threadId, redirect.notebookRelPath)
        active.onEvent({
          type: 'tool.denied',
          threadId,
          toolName,
          reason: redirect.message,
          mode: currentMode,
        })
        return { behavior: 'deny', message: redirect.message } as PermissionResult
      }

      if (policy === 'allow') {
        return { behavior: 'allow', updatedInput: toolInput } as PermissionResult
      }
      // 'prompt' - fall through to approval request flow below

      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const detail = typeof toolInput === 'object'
        ? JSON.stringify(toolInput, null, 2).slice(0, 500)
        : String(toolInput)

      active.onEvent({
        type: 'request.opened',
        threadId,
        requestId,
        requestType: classifyTool(toolName),
        toolName,
        detail,
      })

      // Waiting on the user - expected silence, hold stall reports.
      active.watchdog.suspend()
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        active.pendingApprovals.set(requestId, { requestId, resolve })
      })
      active.watchdog.resume(Date.now())

      active.onEvent({ type: 'request.closed', threadId, requestId, decision })

      return decision === 'approve'
        ? { behavior: 'allow', updatedInput: toolInput } as PermissionResult
        : { behavior: 'deny', message: 'User denied permission' } as PermissionResult
    }

    const claudeBin = findClaudeBin()
    const env = buildClaudeQueryEnv(buildClaudeCliEnv(), active.instanceEnv, active.instanceOauthDir)

    // Auth preflight - see probeClaudeLogin. Spawning against a logged-out
    // profile otherwise hangs indefinitely with no events and no error.
    if (claudeBin) {
      const auth = await probeClaudeLogin(claudeBin, env, active.instanceOauthDir)
      if (!auth.ok) {
        active.onEvent({ type: 'error', threadId, message: auth.message })
        const durationMs = active.turnStartedAt != null ? Date.now() - active.turnStartedAt : undefined
        active.turnStartedAt = null
        active.watchdog.turnEnded()
        active.currentMessageId = null
        active.currentReasoningMessageId = null
        active.partialMessageText.clear()
        active.onEvent({
          type: 'turn.completed',
          threadId,
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
        active.onEvent({ type: 'status', threadId, status: 'error' })
        // Let a later send re-drain (e.g. after the user re-logs in).
        active.draining = false
        return
      }
    }

    // Notebook workspaces get the mirror-format guidance. The SDK default for
    // an unset systemPrompt is the EMPTY string (verified against sdk.mjs), so
    // passing a plain string adds exactly this text and nothing else.
    const notebookPrompt = notebookManager.systemPromptFor(threadId)

    const queryOptions: SDKOptions = {
      cwd: active.session.cwd,
      ...(active.session.model ? { model: active.session.model } : {}),
      ...(notebookPrompt ? { systemPrompt: notebookPrompt } : {}),
      permissionMode,
      // Always enable the dangerously-skip-permissions CLI flag so the user
      // can toggle to Full Access mid-session. Our `canUseTool` is the
      // authoritative gate - the SDK-level checks become advisory. Without
      // this flag, setPermissionMode('bypassPermissions') mid-turn throws
      // "session was not launched with --dangerously-skip-permissions".
      allowDangerouslySkipPermissions: true,
      canUseTool,
      abortController: active.abortController,
      ...(active.session.sessionId ? { resume: active.session.sessionId } : {}),
      // Electron doesn't inherit full shell PATH - pass explicit binary + env
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      env,
      includePartialMessages: true,
      // Buffered as well as logged, so a stall message can quote what the
      // subprocess actually said instead of leaving it in the dev log.
      stderr: (data: string) => {
        log.warn(`claude stderr: ${data.slice(0, 500)}`)
        active.stderrTail.push(data)
      },
    }

    log.info(`starting query: cwd=${active.session.cwd} model=${active.session.model ?? 'default'} mode=${permissionMode} claudeBin=${claudeBin ?? 'auto'} resume=${active.session.sessionId ?? 'none'} CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR ?? '(default ~/.claude)'} PATH=${env.PATH?.slice(0, 200)}`)

    active.session.status = 'running'
    active.onEvent({ type: 'status', threadId, status: 'running' })

    try {
      const q = sdk.query({ prompt: active.prompt, options: queryOptions })
      active.query = q

      for await (const msg of q) {
        this.handleSDKMessage(threadId, active, msg)
      }

      active.session.status = 'idle'
      active.onEvent({ type: 'status', threadId, status: 'idle' })
    } catch (err) {
      // Session was torn down (stop/archive/rotate) - the subprocess exit is
      // expected. Bail before the retry branch, which would otherwise read
      // "exited with code" and respawn a fresh query, re-leaking a process.
      if (this.sessions.get(threadId) !== active) return

      const e = err as { message?: string; stack?: string; cause?: unknown; name?: string }
      log.error(`query failed: ${threadId}`, e?.message ?? err, e?.stack ?? '', e?.cause ?? '')

      // Transcript isn't under the active profile's CLAUDE_CONFIG_DIR (started
      // on another profile). Don't start fresh - that abandons the resume id
      // and loses the thread even on switch-back. Keep sessionId and tell the
      // user to switch back.
      if (/no conversation found/i.test(e?.message ?? '')) {
        log.warn(`resume transcript not under active profile for ${threadId} - preserving resume id so switch-back works`)
        active.session.status = 'idle'
        active.onEvent({
          type: 'error',
          threadId,
          message:
            'This conversation was started under a different profile and its history isn\'t available here. Your context is safe - switch back to the original profile to resume it.',
        })
        active.onEvent({ type: 'status', threadId, status: 'idle' })
      } else if (active.session.sessionId && /exited with code/i.test(e?.message ?? '')) {
        // Resume failed with a subprocess crash (or an imported conversation
        // that never had a Claude transcript) - retry without --resume.
        log.warn(`retrying without --resume for ${threadId}`)
        active.session.sessionId = undefined
        const retryOptions: Record<string, unknown> = { ...queryOptions }
        delete retryOptions.resume

        // Need a fresh prompt queue since the old one was consumed
        active.prompt = new PromptQueue()
        // Re-push the original message (it was already consumed by the failed query)
        // The user already saw their message in UI, so just resend to the agent
        active.onEvent({
          type: 'content',
          threadId,
          messageId: `sys_retry_${Date.now()}`,
          text: '(Retrying as new session - could not resume imported conversation)',
          streamKind: 'reasoning',
        })

        try {
          const q2 = sdk.query({ prompt: active.prompt, options: retryOptions as typeof queryOptions })
          active.query = q2
          for await (const msg of q2) {
            this.handleSDKMessage(threadId, active, msg)
          }
          active.session.status = 'idle'
          active.onEvent({ type: 'status', threadId, status: 'idle' })
        } catch (retryErr) {
          const re = retryErr as { message?: string }
          log.error(`retry also failed: ${threadId}`, re?.message ?? retryErr)
          active.session.status = 'error'
          active.onEvent({
            type: 'error',
            threadId,
            message: formatClaudeStartFailure(re?.message ?? 'Unknown error', claudeCredsKnownPresent(env)),
          })
          active.onEvent({ type: 'status', threadId, status: 'error' })
        }
      } else if (e?.name === 'AbortError' || /abort/i.test(e?.message ?? '')) {
        active.session.status = 'idle'
        active.onEvent({ type: 'status', threadId, status: 'idle' })
      } else {
        active.session.status = 'error'
        active.onEvent({
          type: 'error',
          threadId,
          message: formatClaudeStartFailure(e?.message ?? 'Unknown error', claudeCredsKnownPresent(env)),
        })
        active.onEvent({ type: 'status', threadId, status: 'error' })
      }
    } finally {
      active.query = null
      active.currentMessageId = null
      active.currentReasoningMessageId = null
      active.partialMessageText.clear()
      active.draining = false
      // The query loop is gone, so nothing can arrive for this turn - stop
      // the stall clock even on the paths that never reached `result`.
      active.watchdog.turnEnded()
    }
  }

  async listSkills(threadId: string): Promise<ProviderSkill[]> {
    const active = this.sessions.get(threadId)
    if (!active) return []
    // Prefer the live SDK source-of-truth - `supportedCommands()` reflects
    // both built-ins and any user-defined commands in `.claude/commands/*`.
    // If the query hasn't started yet, fall back to whatever we captured
    // from the system/init event (or empty if neither has happened yet).
    const queryWithCommands = active.query as (typeof active.query & { supportedCommands?: () => Promise<unknown> }) | null
    if (queryWithCommands && typeof queryWithCommands.supportedCommands === 'function') {
      try {
        const cmds = await queryWithCommands.supportedCommands()
        const parsed = parseClaudeSlashCommands(cmds)
        if (parsed.length > 0) {
          active.skills = parsed
          return parsed
        }
      } catch (err) {
        log.warn(`supportedCommands() failed, using cached: ${err}`)
      }
    }
    return active.skills
  }

  async listModels(threadId: string): Promise<Array<{ id: string; label: string; tier: 'fast' | 'balanced' | 'max' }>> {
    const active = this.sessions.get(threadId)
    if (!active) return []
    // Prefer the live SDK source-of-truth - `supportedModels()` reflects the
    // account's actual model availability. If the query hasn't started yet,
    // fall back to whatever we cached from a previous call (or empty).
    if (active.query) {
      try {
        const models = await active.query.supportedModels()
        const mapped = models.map((m) => ({
          id: m.value,
          label: m.displayName,
          tier: inferTier(m.value),
        }))
        if (mapped.length > 0) {
          active.models = mapped
          return mapped
        }
      } catch (err) {
        log.warn(`supportedModels() failed, using cached: ${err}`)
      }
    }
    return active.models
  }

  async interruptTurn(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.query) return
    try {
      await active.query.interrupt()
    } catch {
      // Interrupt may fail if already finished
    }
    log.info(`interrupted: ${threadId}`)
  }

  async setRuntimeMode(threadId: string, mode: RuntimeMode): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    active.session.runtimeMode = mode

    if (active.query) {
      try {
        await active.query.setPermissionMode(RUNTIME_MODE_TO_PERMISSION[mode])
        log.info(`runtime mode updated live: ${threadId} → ${mode}`)
      } catch (err) {
        log.warn(`failed to set permission mode mid-turn: ${err}`)
      }
    }
  }

  async answerQuestion(threadId: string, requestId: string, answers: string[][]): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    const pending = active.pendingQuestions.get(requestId)
    if (!pending) {
      log.warn(`no pending question: ${requestId}`)
      return
    }
    active.pendingQuestions.delete(requestId)
    pending.resolve(answers)
    log.info(`question answered: ${requestId}`)
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return

    const pending = active.pendingApprovals.get(requestId)
    if (!pending) {
      log.warn(`no pending approval: ${requestId}`)
      return
    }

    active.pendingApprovals.delete(requestId)
    pending.resolve(decision)
    log.info(`approval responded: ${requestId} → ${decision}`)
  }

  async stopSession(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return

    // Reap the spawned `claude` CLI subprocess - closing the queue + aborting
    // doesn't kill it, so each stopped session would leak an OS process.
    if (active.query) {
      try {
        active.query.close()
      } catch (err) {
        log.warn(`query.close() failed for ${threadId}`, err)
      }
      active.query = null
    }

    active.watchdog.turnEnded()

    // Close the prompt queue so the SDK generator finishes naturally
    active.prompt.close()

    // Abort any outstanding network work
    active.abortController.abort()

    // Reject pending approvals
    for (const [, pending] of active.pendingApprovals) {
      pending.resolve('deny')
    }
    active.pendingApprovals.clear()

    // Resolve pending questions with empty answers so the SDK doesn't hang
    for (const [, pending] of active.pendingQuestions) {
      pending.resolve([])
    }
    active.pendingQuestions.clear()

    this.sessions.delete(threadId)
    // Keep `lastOauthDir` so a subsequent startSession on the same thread
    // (rotation triggers stopSession + startSession in sequence) still
    // sees the prior profile and can migrate. Cleared on full app shutdown
    // via process exit; per-thread leak is bounded by user thread count.
    log.info(`session stopped: ${threadId}`)
  }

  // ── SDK Message Handler ──────────────────────────────────────

  private handleSDKMessage(
    threadId: string,
    active: ActiveSession,
    msg: SDKMessage,
  ): void {
    // Any message counts as life, including types this switch ignores.
    active.watchdog.activity(Date.now())
    // Auto-approved tools never hit the pendingApprovals path, so this is
    // the only place their (legitimately silent) run gets bracketed.
    countToolBrackets(msg, active.watchdog, Date.now())
    switch (msg.type) {
      case 'system': {
        const sys = msg as SDKMessage & Record<string, unknown>

        // Capture slash commands the SDK announces in `system/init`.
        // The SDK ships them in `slash_commands` (string[]) on subtype 'init',
        // and on newer builds adds a richer `commands` (SlashCommand[]) field.
        // We accept either shape - the slash menu will render whichever
        // arrived. Cached on the active session so listSkills() can return
        // it without re-asking the SDK.
        if (sys.subtype === 'init') {
          const parsed = parseClaudeSlashCommands(sys.commands ?? sys.slash_commands)
          if (parsed.length > 0) {
            active.skills = parsed
            log.info(`captured ${parsed.length} claude slash commands`)
          }
          // Seed real context usage at init - resumed sessions otherwise
          // show the renderer's rough estimate until the next turn ends.
          if (active.query) {
            active.query.getContextUsage().then((ctx) => {
              if (ctx.model) active.lastKnownModel = ctx.model
              active.onEvent({
                type: 'context_window',
                threadId,
                usedTokens: ctx.totalTokens,
                maxTokens: ctx.maxTokens,
                ...(ctx.model ? { model: ctx.model } : {}),
              })
            }).catch((err) => {
              log.warn(`getContextUsage at init failed for ${threadId}: ${err instanceof Error ? err.message : String(err)}`)
            })
          }
        }

        if (sys.session_id) {
          const newId = sys.session_id as string
          const previousId = active.session.sessionId
          // Only record ancestry when the SDK actually ROTATED the
          // session_id mid-turn (i.e. we asked to resume X and got Y back).
          // Previously we recorded on every system event, which incorrectly
          // linked unrelated chats the user just happened to open into some
          // other thread's ancestry chain - and hid them from the sidebar.
          const rotated = previousId && previousId !== newId && newId !== threadId
          active.session.sessionId = newId
          if (rotated) {
            try {
              recordThreadSession(newId, threadId)
            } catch { /* best-effort, don't break the turn */ }
          }
          active.onEvent({
            type: 'session',
            threadId,
            sessionId: newId,
          })
        }

        // Compaction event - context window shrank, refresh usage
        if (sys.subtype === 'status' && sys.compact_result === 'success') {
          log.info(`compaction completed: ${threadId}`)
          if (active.query) {
            active.query.getContextUsage().then((ctx) => {
              if (ctx.model) active.lastKnownModel = ctx.model
              active.onEvent({
                type: 'context_window',
                threadId,
                usedTokens: ctx.totalTokens,
                maxTokens: ctx.maxTokens,
                ...(ctx.model ? { model: ctx.model } : {}),
              })
            }).catch((err) => {
              log.warn(`getContextUsage after compaction failed for ${threadId}: ${err instanceof Error ? err.message : String(err)}`)
            })
          }
        }

        // "compacting" status → show in UI
        if (sys.subtype === 'status' && sys.status === 'compacting') {
          active.onEvent({ type: 'status', threadId, status: 'running' })
          active.onEvent({
            type: 'content',
            threadId,
            messageId: `compact_${Date.now()}`,
            text: 'Compacting context window...',
            streamKind: 'reasoning',
          })
        }

        break
      }

      case 'stream_event': {
        // SDKPartialAssistantMessage (includePartialMessages:true)
        type StreamMsg = SDKMessage & {
          event?: {
            type?: string
            delta?: { type?: string; text?: string; thinking?: string }
          }
        }
        const streamMsg = msg as StreamMsg
        const ev = streamMsg.event
        if (!ev) break

        if (ev.type === 'content_block_delta') {
          const delta = ev.delta
          if (delta?.type === 'text_delta' && delta.text) {
            if (!active.currentMessageId) {
              active.currentMessageId = `msg_${threadId.slice(-6)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            }
            const msgId = active.currentMessageId
            // The accumulated copy is what the closing snapshot below sends,
            // so a client that joined mid-message can still be made whole.
            active.partialMessageText.set(msgId, (active.partialMessageText.get(msgId) ?? '') + delta.text)
            active.onEvent({
              type: 'content',
              threadId,
              messageId: msgId,
              text: delta.text,
              append: true,
              streamKind: 'assistant',
            })
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            if (!active.currentReasoningMessageId) {
              active.currentReasoningMessageId = `think_${threadId.slice(-6)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            }
            const reasonId = active.currentReasoningMessageId
            active.partialMessageText.set(
              reasonId,
              (active.partialMessageText.get(reasonId) ?? '') + delta.thinking,
            )
            active.onEvent({
              type: 'content',
              threadId,
              messageId: reasonId,
              text: delta.thinking,
              append: true,
              streamKind: 'reasoning',
            })
          }
        } else if (ev.type === 'content_block_stop') {
          // Close the message with a SNAPSHOT of the accumulated body.
          //
          // Deltas only reconstruct the whole message for a client that saw
          // every one of them. A client that attached mid-turn, or re-seeded
          // after a replay gap, holds a fragment starting from wherever it
          // joined and nothing would ever repair it - under the old cumulative
          // shape the next event self-healed that. One extra frame per message
          // costs nothing next to the per-token traffic it replaced.
          for (const id of [active.currentMessageId, active.currentReasoningMessageId]) {
            if (!id) continue
            const full = active.partialMessageText.get(id)
            if (full === undefined) continue
            active.onEvent({
              type: 'content',
              threadId,
              messageId: id,
              text: full,
              streamKind: id === active.currentReasoningMessageId ? 'reasoning' : 'assistant',
            })
          }
          active.currentReasoningMessageId = null
        }
        break
      }

      case 'assistant': {
        type ContentBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string }
        const errMsg = msg as SDKMessage & { error?: string; message?: { model?: string; content?: ContentBlock[] } }
        // The CLI injects a synthetic assistant message on API errors (e.g.
        // "You've hit your session limit") alongside the rate_limit_event we
        // already surface as a system error card - rendering both duplicates
        // the error in chat.
        if (errMsg.error || errMsg.message?.model === '<synthetic>') break
        const content = (msg as SDKMessage & { message?: { content?: ContentBlock[] } }).message?.content
        if (!content || !Array.isArray(content)) break

        // Skip text/thinking if already streamed via stream_event deltas.
        const wasStreaming = active.partialMessageText.size > 0

        if (!wasStreaming) {
          const textParts: string[] = []
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              textParts.push(block.text)
            }
          }

          if (textParts.length > 0) {
            const msgId = active.currentMessageId ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            active.currentMessageId = msgId
            active.onEvent({
              type: 'content',
              threadId,
              messageId: msgId,
              text: textParts.join('\n'),
              streamKind: 'assistant',
            })
          }

          for (const block of content) {
            if (block.type === 'thinking' && block.thinking) {
              active.onEvent({
                type: 'content',
                threadId,
                messageId: `think_${Date.now()}`,
                text: block.thinking,
                streamKind: 'reasoning',
              })
            }
          }
        }

        for (const block of content) {
          if (block.type === 'tool_use' && block.id) {
            // Skip tools we render with custom UI (QuestionCard / PlanCard).
            // The canUseTool handler intercepts these and emits question.asked /
            // plan.proposed events instead - showing the raw JSON tool call
            // alongside the custom UI would be duplicate + ugly.
            if (block.name && CUSTOM_UI_TOOLS.has(block.name)) continue
            active.currentMessageId = null
            active.onEvent({
              type: 'tool.started',
              threadId,
              toolId: block.id,
              toolName: block.name || 'Unknown',
              input: block.input,
            })
          }
        }

        active.session.status = 'running'
        active.onEvent({ type: 'status', threadId, status: 'running' })
        break
      }

      case 'user': {
        // Tool results ride a synthetic user message. Without this the only
        // thing settling a tool card was the end of the entire turn.
        for (const result of extractToolResults(msg)) {
          active.onEvent({
            type: 'tool.completed',
            threadId,
            toolId: result.toolId,
            output: result.output,
          })
        }
        break
      }

      case 'result': {
        type ResultMsg = SDKMessage & { total_cost_usd?: number; num_turns?: number; usage?: { input_tokens?: number }; session_id?: string }
        const result = msg as ResultMsg
        active.currentMessageId = null
        active.currentReasoningMessageId = null
        active.partialMessageText.clear()

        const durationMs =
          active.turnStartedAt != null ? Date.now() - active.turnStartedAt : undefined
        active.turnStartedAt = null
        active.watchdog.turnEnded()
        active.onEvent({
          type: 'turn.completed',
          threadId,
          costUsd: result.total_cost_usd,
          numTurns: result.num_turns,
          usedTokens: result.usage?.input_tokens,
          ...(durationMs !== undefined ? { durationMs } : {}),
        })

        if (result.session_id) {
          active.session.sessionId = result.session_id
        }

        // Poll real context window usage from SDK after turn completes
        if (active.query) {
          active.query.getContextUsage().then((ctx) => {
            if (ctx.model) active.lastKnownModel = ctx.model
            active.onEvent({
              type: 'context_window',
              threadId,
              usedTokens: ctx.totalTokens,
              maxTokens: ctx.maxTokens,
              ...(ctx.model ? { model: ctx.model } : {}),
            })
            log.info(`context: ${ctx.totalTokens}/${ctx.maxTokens} (${Math.round(ctx.percentage)}%) model=${ctx.model}`)
          }).catch((err) => {
            log.warn(`getContextUsage post-turn failed for ${threadId}: ${err instanceof Error ? err.message : String(err)}`)
          })
        }

        // Between turns - waiting for next user message
        active.session.status = 'idle'
        active.onEvent({ type: 'status', threadId, status: 'idle' })
        break
      }

      case 'rate_limit_event': {
        // Keep the shape aligned with SDKRateLimitInfo (sdk.d.ts). We log the
        // WHOLE object below, so include the overage fields - an empty
        // {rateLimitType,resetsAt} rejection is usually an overage/credit block,
        // not a five-hour window. See docs/notes/rate-limit-debugging.md.
        type RateLimitMsg = SDKMessage & {
          rate_limit_info?: {
            status?: string
            rateLimitType?: string
            resetsAt?: number
            utilization?: number
            overageStatus?: string
            overageDisabledReason?: string
            isUsingOverage?: boolean
          }
        }
        const rl = (msg as RateLimitMsg).rate_limit_info
        if (rl?.status === 'rejected') {
          // Copy branches in shared/claude-rate-limit.ts: an overage rejection
          // is a spend cap, not a window.
          active.onEvent({
            type: 'error',
            threadId,
            message: buildRateLimitMessage(rl, Date.now(), active.lastKnownModel),
          })
          // Spend blocks only: a real window is not model-specific, so
          // recording one would warn about a model that is fine after it rolls.
          if (isOverageRejection(rl) && active.lastKnownModel) {
            const scope = classifyOverageScope(rl.overageDisabledReason)
            if (scope === 'org' || scope === 'account') {
              active.onEvent({
                type: 'spend.blocked',
                threadId,
                instanceId: active.session.instanceId ?? null,
                model: active.lastKnownModel,
                reason: rl.overageDisabledReason ?? null,
                scope,
                resetsAtMs: unixSecondsToMs(rl.resetsAt),
              })
            }
          }
          // A rejection produces no `result` message, so without an explicit
          // turn end the panel stays stuck on 'running' with no duration badge -
          // this is the "no response, nothing" symptom from the 2026-07-25
          // investigation. Mirror the `result` case: clear turn state and emit
          // turn.completed, then flag the error status.
          const durationMs = active.turnStartedAt != null ? Date.now() - active.turnStartedAt : undefined
          active.turnStartedAt = null
          active.watchdog.turnEnded()
          active.currentMessageId = null
          active.currentReasoningMessageId = null
          active.partialMessageText.clear()
          active.onEvent({
            type: 'turn.completed',
            threadId,
            ...(durationMs !== undefined ? { durationMs } : {}),
          })
          active.onEvent({ type: 'status', threadId, status: 'error' })
          // Log the FULL rate_limit_info. The old line dropped everything except
          // rateLimitType/resetsAt, so an empty-payload rejection logged as `{}`
          // and hid whether it was overage vs a real window - see the doc above.
          log.warn(`rate_limit rejected for ${threadId}`, rl)
        }
        break
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────

function extractPlanMarkdown(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const plan = (input as { plan?: unknown }).plan
  if (typeof plan === 'string' && plan.trim().length > 0) return plan.trim()
  return undefined
}

function parseQuestions(input: unknown): import('../types').Question[] {
  if (!input || typeof input !== 'object') return []
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return []
  return raw.map((q: Record<string, unknown>, idx: number) => ({
    id: typeof q.header === 'string' ? q.header : `q_${idx}`,
    header: typeof q.header === 'string' ? q.header : `Question ${idx + 1}`,
    question: typeof q.question === 'string' ? q.question : '',
    options: Array.isArray(q.options)
      ? q.options.map((opt: Record<string, unknown>) => ({
          label: typeof opt.label === 'string' ? opt.label : '',
          description: typeof opt.description === 'string' ? opt.description : undefined,
        }))
      : [],
    multiSelect: typeof q.multiSelect === 'boolean' ? q.multiSelect : false,
  }))
}

function classifyTool(toolName: string): 'command' | 'file' | 'tool' {
  const commandTools = ['Bash', 'bash', 'shell', 'terminal']
  const fileTools = ['Edit', 'Write', 'Read', 'Glob', 'Grep']

  if (commandTools.some((t) => toolName.toLowerCase().includes(t.toLowerCase()))) {
    return 'command'
  }
  if (fileTools.some((t) => toolName.includes(t))) {
    return 'file'
  }
  return 'tool'
}
