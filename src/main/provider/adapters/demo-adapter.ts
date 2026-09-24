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
 *   - text says "run"    -> asks approval for `npm test` and holds the turn
 *                           open until it is answered (ApprovalCard, and the
 *                           running composer for the visual regression suite)
 *   - text mentions the state check -> a real edit to src/api/auth.ts in the
 *                           session cwd, so the registry's git checkpoint
 *                           emits a genuine `file.edited` (FileDiffCard)
 *   - text mentions "render order" -> reasoning, interim text, a tool that
 *                           runs past the reload merge's 60s window, then the
 *                           answer (e2e/chat-render-order.e2e.mjs)
 *   - text says "to-dos" -> a long markdown list with inline code and branch
 *                           paths (e2e/message-overflow.e2e.mjs)
 *   - anything else      -> a short two-sentence reply
 *
 * With `SB_DEMO_CLAUDE_TRANSCRIPT_DIR` set, the claude adapter also appends a
 * Claude Code shaped JSONL under that config dir, so a reload exercises the
 * same disk + SQLite merge a real Claude chat does.
 */
import type { TurnDelivery } from '@shared/turn-delivery'
import { randomUUID } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { encodeClaudeProjectPath } from '../../projects/session-scanner'
import { LEGACY_ID_MATCH_WINDOW_MS } from '../../agent/dedupe-messages'
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
  /** Runs still going. A steer starts a second one beside the first. */
  turns: Set<DemoTurn>
  /** Queued messages that have not started, oldest first. */
  queued: DemoQueuedTurn[]
  /** Approvals a script is blocked on, by request id. */
  approvals: Map<string, (decision: ApprovalDecision | 'cancelled') => void>
  /** Claude-shaped transcript this session appends to, when enabled. */
  transcript?: string
}

/** One script run. */
interface DemoTurn {
  session: DemoSession
  /** Time this run has paused for; reported as the turn duration. */
  scriptedMs: number
  /** Set by interrupt or stop; a later message does not clear it. */
  cancelled: boolean
}

interface DemoQueuedTurn {
  id?: string
  message: string
}

/** Long inline code and file-pill paths in lists (e2e/message-overflow.e2e.mjs). */
const TODO_REPLY = `**Left to-dos**

**Release path (in progress)**
1. **#121, UI primitives:** Waiting for its last CI and CodeRabbit round. It may need one more merge from main after #122.
2. **#120, naming rename:** Generate it again on the final main, check it, and merge it.
3. **v0.8.68:** Ships everything merged since v0.8.67.

**Broken or flaky tests**

4. **\`code-copy-controls\` e2e:** It fails on main, at the tool-call click.
5. **\`dual-chat-workspace\` e2e:** It is flaky, because the analytics notice sometimes covers a sidebar button.
6. **\`machine-layer\` e2e:** It uses a stale selector.
7. **Screenshot run:** The Playwright clock setup still fails about 1 run in 4.
8. **Dependency-clone unit test:** It leaves a temp folder that cannot be read.
9. **Local test gate:** Timing tests fail when many jobs run at once. I keep fewer jobs in parallel.

**Known gaps in shipped features**

10. **Task notifications:** The live Claude task notification is ignored, so its row appears only after a reload.
11. **Chat order in old chats:** An old chat with a mid-turn steer can still show early text below the answer.
12. **Reasoning on reload:** Reasoning is not saved, so it does not come back on reload.
13. **Translucent glass:** Popover blur is not confirmed. The native-glass check needs Screen Recording permission and does not run in CI.

**Staged behind flags (phone and Android)**

14. The agent digest in the Android conversation list.
15. The collapsed diff group on the phone and Android.
16. The "Needs you" group on the phone and Android.
17. The agent digest for OpenCode, which has no place for extra instructions.

**UI polish, continuing**

18. **More shadcn:** Menus, popovers and dialogs move to Radix, for example the provider picker, the branch picker, the slash menu and the command palette.
19. **Inline styles:** Move a file off inline styles whenever we touch it anyway.

**Deferred (in \`roadmap-deferred.md\`)**

20. **Settled completion:** This needs peer-reply tracking in the backend first.
21. **Full CoW sandboxes.**

**Manual checks that nobody has run**

22. Auto mode live, the update prompt, and the catalog probe on a remote VM.
23. Pending-approval recovery with a real server restart.
24. The agent digest and the sidebar "Needs you" group in a live Claude and Codex session.

**Housekeeping**

25. **Main checkout:** It is still on the merged branch \`chore/release-0.8.64\`.
26. **\`feature-x\` worktree:** It is merged, but it has an uncommitted \`CLAUDE.md\` change.
27. **Old PR #75** (\`fix/update-restart-idempotent\`): It is from before this session and is still open.

Items 1 to 3 go first. I suggest items 4 to 8 next, as one test-reliability batch on the three allowed accounts. Tell me if you want a different order.

\`\`\`sh
gh pr view 75 --json state,mergeable,headRefName,baseRefName,statusCheckRollup --jq '.statusCheckRollup[].conclusion'
\`\`\``

const LONG_TOOL_MS = LEGACY_ID_MATCH_WINDOW_MS + 1_000

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
      turns: new Set(),
      queued: [],
      approvals: new Map(),
    }
    const transcriptRoot = process.env.SB_DEMO_CLAUDE_TRANSCRIPT_DIR
    if (transcriptRoot && this.provider === 'claude') {
      const dir = join(transcriptRoot, 'projects', encodeClaudeProjectPath(opts.cwd))
      mkdirSync(dir, { recursive: true })
      session.transcript = join(dir, `demo-${opts.threadId}.jsonl`)
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
    queuedId?: string,
  ): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session) throw new Error(`No demo session: ${threadId}`)
    if (runtimeMode) session.runtimeMode = runtimeMode
    // Like the real adapters: a queued message waits for the current script,
    // and can be cancelled or promoted until then.
    if (delivery === 'queue' && (session.turns.size > 0 || session.queued.length > 0)) {
      const entry: DemoQueuedTurn = { id: queuedId, message }
      session.queued.push(entry)
      if (queuedId) session.onEvent({ type: 'turn.queued', threadId, messageId: queuedId })
      session.running = this.guard(threadId, session, session.running.then(() => {
        const index = session.queued.indexOf(entry)
        if (index < 0) return
        session.queued.splice(index, 1)
        if (entry.id) session.onEvent({ type: 'turn.dequeued', threadId, messageId: entry.id, reason: 'started' })
        return this.run(threadId, session, message)
      }))
      return
    }
    session.running = this.guard(threadId, session, this.run(threadId, session, message))
  }

  private guard(threadId: string, session: DemoSession, task: Promise<void>): Promise<void> {
    return task.catch((err) => {
      log.error('demo script failed', err)
      session.onEvent({ type: 'error', threadId, message: err instanceof Error ? err.message : String(err) })
      session.onEvent({ type: 'status', threadId, status: 'idle' })
    })
  }

  private takeQueued(session: DemoSession | undefined, queuedId: string): DemoQueuedTurn | null {
    const index = session?.queued.findIndex((entry) => entry.id === queuedId) ?? -1
    if (!session || index < 0) return null
    return session.queued.splice(index, 1)[0]
  }

  async cancelQueuedTurn(threadId: string, queuedId: string): Promise<boolean> {
    const session = this.sessions.get(threadId)
    if (!session || !this.takeQueued(session, queuedId)) return false
    session.onEvent({ type: 'turn.dequeued', threadId, messageId: queuedId, reason: 'cancelled' })
    return true
  }

  /** Runs the message beside the current script, which is what a steer is here. */
  async promoteQueuedTurn(threadId: string, queuedId: string): Promise<boolean> {
    const session = this.sessions.get(threadId)
    const entry = this.takeQueued(session, queuedId)
    if (!session || !entry) return false
    session.onEvent({ type: 'turn.dequeued', threadId, messageId: queuedId, reason: 'promoted' })
    void this.guard(threadId, session, this.run(threadId, session, entry.message))
    return true
  }

  private async run(threadId: string, session: DemoSession, message: string): Promise<void> {
    const turn: DemoTurn = { session, scriptedMs: 0, cancelled: false }
    session.turns.add(turn)
    try {
      await this.script(threadId, turn, message)
    } finally {
      session.turns.delete(turn)
    }
    if (turn.cancelled) return
    session.onEvent({ type: 'turn.completed', threadId, durationMs: turn.scriptedMs, numTurns: 1 })
    // Another run (a steer) may still be going, or blocked on an approval.
    if (session.turns.size === 0) session.onEvent({ type: 'status', threadId, status: 'idle' })
  }

  private async script(threadId: string, turn: DemoTurn, message: string): Promise<void> {
    const { session } = turn
    const emit = (event: RuntimeEvent): void => {
      if (!turn.cancelled) session.onEvent(event)
    }
    // Written when the message runs, as Claude does for a queued one.
    this.record(session, 'user', [{ type: 'text', text: message }])
    emit({ type: 'status', threadId, status: 'running' })
    await this.pause(turn, 500)

    if (session.runtimeMode === 'plan') {
      await this.say(threadId, turn, 'I will start by reading the existing callback handler.')
      await this.tool(threadId, turn, 'Read', { file_path: 'src/api/auth.ts' }, '7 lines')
      await this.tool(threadId, turn, 'Read', { file_path: 'src/components/LoginButton.tsx' }, '3 lines')
      await this.say(
        threadId,
        turn,
        'The state token is checked after the exchange. I would move the check ahead of the fetch and keep the callback idempotent.',
      )
      await this.pause(turn, 350)
      emit({ type: 'tool.denied', threadId, toolName: 'Write', reason: denialMessage('plan', 'Write'), mode: 'plan' })
      await this.pause(turn, 600)
      await this.say(threadId, turn, 'Plan mode blocks writes. Switch to Sandbox or Accept Edits and I will apply the change.')
    } else if (/\brun\b/i.test(message)) {
      await this.say(threadId, turn, 'Running the auth tests to confirm the fix.')
      // Interrupted before the approval opened: registering it now would
      // leave a promise nothing resolves, and a queued turn behind it.
      if (turn.cancelled) return
      const requestId = `demo_req_${++this.seq}`
      const decision = await new Promise<ApprovalDecision | 'cancelled'>((resolve) => {
        session.approvals.set(requestId, resolve)
        emit({ type: 'request.opened', threadId, requestId, requestType: 'command', toolName: 'Bash', detail: 'npm test' })
      })
      session.approvals.delete(requestId)
      // Close it even when cancelled, or the registry keeps replaying an
      // approval nobody can answer.
      session.onEvent({ type: 'request.closed', threadId, requestId, decision: decision === 'cancelled' ? 'deny' : decision })
      if (decision === 'cancelled') return
      if (decision === 'approve') {
        await this.tool(threadId, turn, 'Bash', { command: 'npm test' }, 'ok 1 - exchanges an OAuth code once\nok 2 - rejects an expired state token')
        await this.say(threadId, turn, 'Both tests pass.')
      } else {
        await this.say(threadId, turn, 'Skipped the test run.')
      }
    } else if (/state|validat|fix|apply|move/i.test(message)) {
      await this.say(threadId, turn, 'Moving the state check ahead of the token exchange.')
      await this.tool(threadId, turn, 'Edit', { file_path: 'src/api/auth.ts' }, undefined, () => {
        const target = join(session.cwd, 'src', 'api', 'auth.ts')
        if (existsSync(target)) writeFileSync(target, FIXED_AUTH_TS)
      })
      await this.say(
        threadId,
        turn,
        'Done. The callback now rejects an expired state before any network call. Review the diff below and accept or reject each hunk.',
      )
    } else if (/render order/i.test(message)) {
      emit({ type: 'content', threadId, messageId: `demo_think_${++this.seq}`, streamKind: 'reasoning', text: 'Weighing where the order could break.' })
      await sleep(300)
      await this.say(threadId, turn, 'Interim note: checking the reload path first.')
      await this.tool(threadId, turn, 'Bash', { command: 'sleep 61' }, 'ok', undefined, LONG_TOOL_MS)
      await this.say(threadId, turn, 'Final answer: the order holds.')
    } else if (/to-dos/i.test(message)) {
      await this.say(threadId, turn, TODO_REPLY)
    } else {
      await this.say(
        threadId,
        turn,
        'Two focused tests cover it: reject an expired state before network I/O, and exchange a valid code exactly once.',
      )
    }
  }

  /**
   * Sleep as part of the script. The turn reports the sum of these pauses
   * rather than wall-clock time, so "Worked for 3.2s" is identical on every
   * run (the visual regression suite captures it).
   */
  private async pause(turn: DemoTurn, ms: number): Promise<void> {
    turn.scriptedMs += ms
    await sleep(ms)
  }

  /** Stream one assistant message word by word, like a real provider does. */
  private async say(threadId: string, turn: DemoTurn, text: string): Promise<void> {
    const { session } = turn
    const messageId = `demo_${Date.now()}_${++this.seq}`
    const words = text.split(' ')
    for (let i = 0; i < words.length; i++) {
      if (turn.cancelled) return
      const chunk = (i === 0 ? '' : ' ') + words[i]
      session.onEvent({ type: 'content', threadId, messageId, streamKind: 'assistant', text: chunk, append: i > 0 })
      await this.pause(turn, 28)
    }
    this.record(session, 'assistant', [{ type: 'text', text }])
    await this.pause(turn, 320)
  }

  private async tool(
    threadId: string,
    turn: DemoTurn,
    toolName: string,
    input: unknown,
    output?: string,
    sideEffect?: () => void,
    durationMs = 520,
  ): Promise<void> {
    const { session } = turn
    if (turn.cancelled) return
    const toolId = `demo_tool_${Date.now()}_${++this.seq}`
    session.onEvent({ type: 'tool.started', threadId, toolId, toolName, input })
    this.record(session, 'assistant', [{ type: 'tool_use', id: toolId, name: toolName, input }])
    await this.pause(turn, durationMs)
    // An interrupt during the wait ends the tool here, not after its effect.
    if (turn.cancelled) return
    sideEffect?.()
    session.onEvent({ type: 'tool.completed', threadId, toolId, output })
    await this.pause(turn, 260)
  }

  /** One transcript line, stamped when written, as Claude Code does. */
  private record(session: DemoSession, type: 'user' | 'assistant', content: unknown[]): void {
    if (!session.transcript) return
    const line = { type, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: type, content } }
    appendFileSync(session.transcript, `${JSON.stringify(line)}\n`)
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session) return
    for (const turn of session.turns) turn.cancelled = true
    for (const resolve of session.approvals.values()) resolve('cancelled')
    session.onEvent({ type: 'status', threadId, status: 'idle' })
  }

  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    this.sessions.get(threadId)?.approvals.get(requestId)?.(decision)
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    for (const turn of session?.turns ?? []) turn.cancelled = true
    for (const resolve of session?.approvals.values() ?? []) resolve('cancelled')
    for (const entry of session?.queued.splice(0) ?? []) {
      if (entry.id) session?.onEvent({ type: 'turn.dequeued', threadId, messageId: entry.id, reason: 'dropped' })
    }
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
