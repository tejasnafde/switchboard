/**
 * Scripted provider adapter for recording the feature tour.
 *
 * Enabled ONLY when `SB_DEMO_ADAPTER=1` is in the environment (see the
 * ProviderRegistry constructor). It replaces every real adapter with one that
 * streams canned replies, so `videos/capture-tour.mjs` can record agent-driven
 * scenes (a plan-mode denial, a diff card) deterministically, with no
 * credentials and no network. Nothing here is reachable from a normal launch.
 *
 * The scripts are keyed on runtime mode and on the user text so each tour
 * scene can steer the reply without a side channel:
 *   - plan mode          -> two reads, then a denied Write (denial pill)
 *   - text mentions the state check -> a real edit to src/api/auth.ts in the
 *                           session cwd, so the registry's git checkpoint
 *                           emits a genuine `file.edited` (FileDiffCard)
 *   - text says "run"    -> asks approval for `npm test` and holds the turn
 *                           open until it is answered (ApprovalCard, and the
 *                           running composer for the visual regression suite)
 *   - anything else      -> a short two-sentence reply
 */
import type { TurnDelivery } from '@shared/turn-delivery'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../types'
import type {
  ApprovalDecision,
  ProviderKind,
  RuntimeEvent,
  RuntimeMode,
} from '@shared/provider-events'
import type { ProviderSkill } from '@shared/types'
import { denialMessage } from '../policy'
import { createMainLogger } from '../../logger'

const log = createMainLogger('provider:demo')

const FIXED_AUTH_TS = [
  "import { verifyState } from './state'",
  '',
  'export async function exchangeCode(code: string, state: string) {',
  '  if (!verifyState(state)) {',
  "    throw new Error('expired or unknown state token')",
  '  }',
  "  const response = await fetch('/api/oauth/token', {",
  "    method: 'POST',",
  '    body: JSON.stringify({ code }),',
  '  })',
  '  return response.json()',
  '}',
  '',
].join('\n')

const SKILLS: Record<ProviderKind, ProviderSkill[]> = {
  claude: [
    { name: 'review', description: 'Review a pull request', source: 'claude-code' },
    { name: 'commit', description: 'Commit staged changes with a message', source: 'claude-code' },
    { name: 'init', description: 'Initialize CLAUDE.md for this repo', source: 'claude-code' },
  ],
  codex: [
    { name: 'explain', description: 'Explain the selected code', source: 'codex' },
  ],
  opencode: [],
}

interface DemoSession {
  /** The script now running, so a queued message can wait for it. */
  running: Promise<void>
  onEvent: (event: RuntimeEvent) => void
  cwd: string
  runtimeMode: RuntimeMode
  cancelled: boolean
  /** Time the current script has paused for; reported as the turn duration. */
  scriptedMs: number
  /** Resolves the approval the running script is blocked on, if any. */
  pendingApproval?: { requestId: string; resolve: (decision: ApprovalDecision | 'cancelled') => void }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class DemoAdapter implements ProviderAdapter {
  private sessions = new Map<string, DemoSession>()
  private seq = 0

  constructor(readonly provider: ProviderKind) {}

  async startSession(opts: SessionStartOpts, onEvent: (event: RuntimeEvent) => void): Promise<ProviderSession> {
    const session: DemoSession = {
      onEvent,
      cwd: opts.cwd,
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      running: Promise.resolve(),
      cancelled: false,
      scriptedMs: 0,
    }
    this.sessions.set(opts.threadId, session)
    onEvent({ type: 'status', threadId: opts.threadId, status: 'connecting' })
    await sleep(150)
    onEvent({ type: 'session', threadId: opts.threadId, sessionId: `demo-${opts.threadId}` })
    onEvent({ type: 'status', threadId: opts.threadId, status: 'idle' })
    return {
      threadId: opts.threadId,
      provider: this.provider,
      status: 'idle',
      model: opts.model,
      runtimeMode: session.runtimeMode,
      cwd: opts.cwd,
      sessionId: `demo-${opts.threadId}`,
      createdAt: Date.now(),
    }
  }

  async sendTurn(
    threadId: string,
    message: string,
    runtimeMode?: RuntimeMode,
    _images?: Array<{ url: string; mimeType?: string }>,
    delivery?: TurnDelivery,
  ): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session) throw new Error(`No demo session: ${threadId}`)
    if (runtimeMode) session.runtimeMode = runtimeMode
    session.cancelled = false
    // Like the real adapters: a queued message runs after the current script.
    const previous = delivery === 'queue' ? session.running : Promise.resolve()
    const task = previous.then(() => this.run(threadId, session, message)).catch((err) => {
      log.error('demo script failed', err)
      session.onEvent({ type: 'error', threadId, message: err instanceof Error ? err.message : String(err) })
      session.onEvent({ type: 'status', threadId, status: 'idle' })
    })
    session.running = task
  }

  private async run(threadId: string, session: DemoSession, message: string): Promise<void> {
    session.scriptedMs = 0
    const emit = (event: RuntimeEvent): void => {
      if (!session.cancelled) session.onEvent(event)
    }
    emit({ type: 'status', threadId, status: 'running' })
    await this.pause(session, 500)

    if (session.runtimeMode === 'plan') {
      await this.say(threadId, session, 'I will start by reading the existing callback handler.')
      await this.tool(threadId, session, 'Read', { file_path: 'src/api/auth.ts' }, '7 lines')
      await this.tool(threadId, session, 'Read', { file_path: 'src/components/LoginButton.tsx' }, '3 lines')
      await this.say(
        threadId,
        session,
        'The state token is checked after the exchange. I would move the check ahead of the fetch and keep the callback idempotent.',
      )
      await this.pause(session, 350)
      emit({ type: 'tool.denied', threadId, toolName: 'Write', reason: denialMessage('plan', 'Write'), mode: 'plan' })
      await this.pause(session, 600)
      await this.say(threadId, session, 'Plan mode blocks writes. Switch to Sandbox or Accept Edits and I will apply the change.')
    } else if (/state|validat|fix|apply|move/i.test(message)) {
      await this.say(threadId, session, 'Moving the state check ahead of the token exchange.')
      await this.tool(threadId, session, 'Edit', { file_path: 'src/api/auth.ts' }, undefined, () => {
        const target = join(session.cwd, 'src', 'api', 'auth.ts')
        if (existsSync(target)) writeFileSync(target, FIXED_AUTH_TS)
      })
      await this.say(
        threadId,
        session,
        'Done. The callback now rejects an expired state before any network call. Review the diff below and accept or reject each hunk.',
      )
    } else if (/\brun\b/i.test(message)) {
      await this.say(threadId, session, 'Running the auth tests to confirm the fix.')
      const requestId = `demo_req_${++this.seq}`
      const decision = await new Promise<ApprovalDecision | 'cancelled'>((resolve) => {
        session.pendingApproval = { requestId, resolve }
        emit({ type: 'request.opened', threadId, requestId, requestType: 'command', toolName: 'Bash', detail: 'npm test' })
      })
      session.pendingApproval = undefined
      if (decision === 'cancelled') return
      emit({ type: 'request.closed', threadId, requestId, decision })
      if (decision === 'approve') {
        await this.tool(threadId, session, 'Bash', { command: 'npm test' }, 'ok 1 - exchanges an OAuth code once\nok 2 - rejects an expired state token')
        await this.say(threadId, session, 'Both tests pass.')
      } else {
        await this.say(threadId, session, 'Skipped the test run.')
      }
    } else {
      await this.say(
        threadId,
        session,
        'Two focused tests cover it: reject an expired state before network I/O, and exchange a valid code exactly once.',
      )
    }

    emit({ type: 'turn.completed', threadId, durationMs: session.scriptedMs, numTurns: 1 })
    emit({ type: 'status', threadId, status: 'idle' })
  }

  /**
   * Sleep as part of the script. The turn reports the sum of these pauses
   * rather than wall-clock time, so "Worked for 3.2s" is identical on every
   * run (the visual regression suite captures it).
   */
  private async pause(session: DemoSession, ms: number): Promise<void> {
    session.scriptedMs += ms
    await sleep(ms)
  }

  /** Stream one assistant message word by word, like a real provider does. */
  private async say(threadId: string, session: DemoSession, text: string): Promise<void> {
    const messageId = `demo_${Date.now()}_${++this.seq}`
    const words = text.split(' ')
    for (let i = 0; i < words.length; i++) {
      if (session.cancelled) return
      const chunk = (i === 0 ? '' : ' ') + words[i]
      session.onEvent({ type: 'content', threadId, messageId, streamKind: 'assistant', text: chunk, append: i > 0 })
      await this.pause(session, 28)
    }
    await this.pause(session, 320)
  }

  private async tool(
    threadId: string,
    session: DemoSession,
    toolName: string,
    input: unknown,
    output?: string,
    sideEffect?: () => void,
  ): Promise<void> {
    if (session.cancelled) return
    const toolId = `demo_tool_${++this.seq}`
    session.onEvent({ type: 'tool.started', threadId, toolId, toolName, input })
    await this.pause(session, 520)
    sideEffect?.()
    session.onEvent({ type: 'tool.completed', threadId, toolId, output })
    await this.pause(session, 260)
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session) return
    session.cancelled = true
    session.pendingApproval?.resolve('cancelled')
    session.onEvent({ type: 'status', threadId, status: 'idle' })
  }

  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.sessions.get(threadId)?.pendingApproval
    if (pending?.requestId === requestId) pending.resolve(decision)
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (session) session.cancelled = true
    session?.pendingApproval?.resolve('cancelled')
    this.sessions.delete(threadId)
  }

  async setRuntimeMode(threadId: string, mode: RuntimeMode): Promise<void> {
    const session = this.sessions.get(threadId)
    if (session) session.runtimeMode = mode
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  async listSkills(): Promise<ProviderSkill[]> {
    return SKILLS[this.provider]
  }
}

/** One scripted adapter per provider kind, so switching agents keeps working. */
export function demoAdapters(): Map<ProviderKind, ProviderAdapter> {
  log.warn('SB_DEMO_ADAPTER=1: every provider is the scripted demo adapter')
  return new Map<ProviderKind, ProviderAdapter>([
    ['claude', new DemoAdapter('claude')],
    ['codex', new DemoAdapter('codex')],
    ['opencode', new DemoAdapter('opencode')],
  ])
}
