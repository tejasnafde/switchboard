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
 *   - anything else      -> a short two-sentence reply
 */
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
  onEvent: (event: RuntimeEvent) => void
  cwd: string
  runtimeMode: RuntimeMode
  cancelled: boolean
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
      cancelled: false,
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

  async sendTurn(threadId: string, message: string, runtimeMode?: RuntimeMode): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session) throw new Error(`No demo session: ${threadId}`)
    if (runtimeMode) session.runtimeMode = runtimeMode
    session.cancelled = false
    void this.run(threadId, session, message).catch((err) => {
      log.error('demo script failed', err)
      session.onEvent({ type: 'error', threadId, message: err instanceof Error ? err.message : String(err) })
      session.onEvent({ type: 'status', threadId, status: 'idle' })
    })
  }

  private async run(threadId: string, session: DemoSession, message: string): Promise<void> {
    const startedAt = Date.now()
    const emit = (event: RuntimeEvent): void => {
      if (!session.cancelled) session.onEvent(event)
    }
    emit({ type: 'status', threadId, status: 'running' })
    await sleep(500)

    if (session.runtimeMode === 'plan') {
      await this.say(threadId, session, 'I will start by reading the existing callback handler.')
      await this.tool(threadId, session, 'Read', { file_path: 'src/api/auth.ts' }, '7 lines')
      await this.tool(threadId, session, 'Read', { file_path: 'src/components/LoginButton.tsx' }, '3 lines')
      await this.say(
        threadId,
        session,
        'The state token is checked after the exchange. I would move the check ahead of the fetch and keep the callback idempotent.',
      )
      await sleep(350)
      emit({ type: 'tool.denied', threadId, toolName: 'Write', reason: denialMessage('plan', 'Write'), mode: 'plan' })
      await sleep(600)
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
    } else {
      await this.say(
        threadId,
        session,
        'Two focused tests cover it: reject an expired state before network I/O, and exchange a valid code exactly once.',
      )
    }

    emit({ type: 'turn.completed', threadId, durationMs: Date.now() - startedAt, numTurns: 1 })
    emit({ type: 'status', threadId, status: 'idle' })
  }

  /** Stream one assistant message word by word, like a real provider does. */
  private async say(threadId: string, session: DemoSession, text: string): Promise<void> {
    const messageId = `demo_${Date.now()}_${++this.seq}`
    const words = text.split(' ')
    for (let i = 0; i < words.length; i++) {
      if (session.cancelled) return
      const chunk = (i === 0 ? '' : ' ') + words[i]
      session.onEvent({ type: 'content', threadId, messageId, streamKind: 'assistant', text: chunk, append: i > 0 })
      await sleep(28)
    }
    await sleep(320)
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
    await sleep(520)
    sideEffect?.()
    session.onEvent({ type: 'tool.completed', threadId, toolId, output })
    await sleep(260)
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session) return
    session.cancelled = true
    session.onEvent({ type: 'status', threadId, status: 'idle' })
  }

  async respondToRequest(_threadId: string, _requestId: string, _decision: ApprovalDecision): Promise<void> {}

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (session) session.cancelled = true
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
