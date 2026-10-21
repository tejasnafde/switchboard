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
 *   - text says "reply to the review" -> a Switchboard MCP pull request write
 *                           card (reply on demo PR #612, the mock's quote),
 *                           held until answered; nothing is ever posted
 *   - text says "draft a review" -> a Switchboard MCP draft review card
 *                           (three line comments on demo PR #161, which the
 *                           user did not write, so every verdict is offered);
 *                           held until answered; nothing is ever posted
 *   - text says "raise a pull request" -> a Switchboard MCP create card (a
 *                           Bitbucket pull request from feat/sync-jitter into
 *                           main); held until answered; nothing is ever opened
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
 *   - text says "draw"   -> a ```mermaid diagram and a ```chart bar chart,
 *                           drawn in the chat (visual regression screens)
 *   - text says "live page" -> two ```html-live pages: a Chart.js chart and a
 *                           D3 page that throws (visual regression screens)
 *   - text says "live probe" -> an ```html-live page that tries to leave the
 *                           sandbox (e2e/html-live.e2e.mjs)
 *   - text says "tall live page" -> an ```html-live page taller than the
 *                           folded frame, then text under it (e2e/html-live.e2e.mjs)
 *   - anything else      -> a short two-sentence reply
 *
 * With `SB_DEMO_CLAUDE_TRANSCRIPT_DIR` set, the claude adapter also appends a
 * Claude Code shaped JSONL under that config dir, so a reload exercises the
 * same disk + SQLite merge a real Claude chat does.
 */
import type { TurnDelivery } from '@shared/turn-delivery'
import {
  AGENT_REPLY_MAX_CHARS,
  hostWriteDetail,
  type HostWriteCard,
  type HostWriteDiffLine,
} from '@shared/agent-host-writes'
import { PR_DESCRIPTION_MAX_CHARS } from '@shared/agent-pr-create'
import { agentLabel, toAgentProvider, type AgentProvider, type AgentType } from '@shared/types'
import { CLAUDE_MODELS, type ModelOption, type ReasoningEffort } from '@shared/models'
import { buildWindow, type ProviderUsage, type UsageWindow } from '@shared/provider-usage'
import { randomUUID } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { encodeClaudeProjectPath } from '../../projects/session-scanner'
import { LEGACY_ID_MATCH_WINDOW_MS } from '../../agent/dedupe-messages'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../types'
import type { ApprovalDecision, ProviderKind, RuntimeEvent, RuntimeMode } from '@shared/provider-events'
import type { ProviderSkill } from '@shared/types'
import { denialMessage } from '../policy'
import { createMainLogger } from '../../logger'

const log = createMainLogger('provider:demo')

const ctx = (newLine: number, text: string): HostWriteDiffLine => ({
  kind: 'context',
  text,
  oldLine: newLine - 4,
  newLine,
  target: false,
})
const add = (newLine: number, text: string, target = false): HostWriteDiffLine => ({
  kind: 'add',
  text,
  oldLine: null,
  newLine,
  target,
})

/** The draft review the "draft a review" script opens: demo PR #161, the Kanban cost cap. */
const DEMO_REVIEW: HostWriteCard['review'] = {
  summary:
    'The cap works and the migration is safe to re-run. Two things before it merges: a cap of 0 is treated as no cap, and the input takes negative numbers.',
  comments: [
    {
      id: 'c1',
      path: 'src/main/db/kanban.ts',
      side: 'new',
      line: 88,
      text: 'A cap of 0 falls through as falsy here, so it means "no cap". Compare with null instead.',
      excerpt: [
        ctx(87, '  const used = card.cost_used_usd ?? 0'),
        add(88, '  if (!card.cost_cap_usd) return false', true),
        add(89, '  return used >= card.cost_cap_usd'),
      ],
    },
    {
      id: 'c2',
      path: 'src/renderer/components/kanban/CardModal.tsx',
      side: 'new',
      line: 141,
      text: 'Add min={0} and reject a negative value in the save handler too; the field is typed but not checked.',
      excerpt: [
        add(140, '        <input'),
        add(141, '          type="number"', true),
        add(142, "          value={costCap ?? ''}"),
      ],
    },
    {
      id: 'c3',
      path: 'src/shared/kanban.ts',
      side: 'new',
      line: 12,
      text: 'Nit: costCapUsd, to match the column name.',
      excerpt: [
        ctx(11, 'export interface KanbanCard {'),
        add(12, '  cap?: number | null', true),
        ctx(13, '  status: KanbanStatus'),
      ],
    },
  ],
  verdicts: ['comment', 'approve', 'request_changes'],
}

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

const SKILLS: Partial<Record<ProviderKind, ProviderSkill[]>> = {
  claude: [
    { name: 'review', description: 'Review a pull request', source: 'claude-code' },
    { name: 'commit', description: 'Commit staged changes with a message', source: 'claude-code' },
    { name: 'init', description: 'Initialize CLAUDE.md for this repo', source: 'claude-code' },
  ],
  codex: [{ name: 'explain', description: 'Explain the selected code', source: 'codex' }],
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
const VISUALS_REPLY = [
  'Here is how a chat opens now:',
  '',
  '```mermaid',
  'flowchart LR',
  '  open[Open chat] --> load[Load window]',
  '  load --> tail[Parse tail]',
  '  load --> images[Image refs]',
  '  tail --> render[Render]',
  '  images --> render',
  '```',
  '',
  'And chat.open before and after, in ms:',
  '',
  '```chart',
  '{"type":"bar","labels":["long chat","short chat"],"series":[{"name":"before","values":[3800,1100]},{"name":"after","values":[400,150]}],"yTitle":"ms"}',
  '```',
].join('\n')

/** Two inline live pages: a chart that draws and a page that throws under what it drew. */
const LIVE_PAGES_REPLY = [
  'p95 went from about 180 ms to 320 ms after the v2.41.0 deploy on Tuesday, and came back after the hotfix.',
  '',
  '```html-live title="p95 latency, Mon to Wed"',
  '<script src="/_sb/chart.js"></script>',
  '<div style="height:240px"><canvas id="c"></canvas></div>',
  '<script>',
  'const css = getComputedStyle(document.documentElement)',
  'const v = (n) => css.getPropertyValue(n).trim()',
  "const hours = Array.from({ length: 72 }, (_, i) => ['Mon', 'Tue', 'Wed'][Math.floor(i / 24)] + ' ' + (i % 24) + ':00')",
  'const p95 = hours.map((_, i) => (i >= 38 && i < 59 ? 320 : 180) + ((i * 37) % 23))',
  'const p50 = hours.map((_, i) => 70 + ((i * 13) % 9))',
  'new Chart(c, {',
  "  type: 'line',",
  '  data: { labels: hours, datasets: [',
  "    { label: 'p95', data: p95, borderColor: v('--sb-accent'), pointRadius: 0, borderWidth: 2 },",
  "    { label: 'p50', data: p50, borderColor: v('--sb-muted'), pointRadius: 0, borderWidth: 1.5 } ] },",
  "  options: { animation: false, maintainAspectRatio: false, plugins: { legend: { labels: { color: v('--sb-muted') } } },",
  "    scales: { x: { ticks: { color: v('--sb-muted'), maxTicksLimit: 6 }, grid: { color: v('--sb-border') } },",
  "      y: { ticks: { color: v('--sb-muted') }, grid: { color: v('--sb-border') } } } },",
  '})',
  '</script>',
  '```',
  '',
  'And the queue under that load:',
  '',
  '```html-live title="Queue depth simulation"',
  '<script src="/_sb/d3.js"></script>',
  '<p>Workers: 4 · arrivals: 120/s</p>',
  '<script>',
  'const y = d3.scaleLinear().domain([0, 400]).nice()',
  'y.nice.ticksEvery(50)',
  '</script>',
  '```',
].join('\n')

/** An inline live page taller than the folded frame, with text under it to scroll past. */
const LIVE_TALL_REPLY = [
  'The full incident timeline:',
  '',
  '```html-live title="Incident timeline"',
  '<div style="height:720px;background:linear-gradient(var(--sb-accent),var(--sb-bg))"></div>',
  '```',
  '',
  ...Array.from(
    { length: 12 },
    (_, i) => `${i + 1}. Step ${i + 1} of the follow-up, written out so the reply runs past the page.`,
  ),
].join('\n')

/** An inline live page that tries every way out of the sandbox and logs each result. */
const LIVE_PROBE_REPLY = [
  'Probe page:',
  '',
  '```html-live title="Sandbox probe"',
  '<p>probe</p>',
  '<script>',
  "const report = (m) => console.error('PROBE ' + m)",
  "const attempt = (label, run) => run().then((ok) => report((ok ? 'LEAK ' : 'BLOCKED ') + label), () => report('BLOCKED ' + label))",
  "attempt('network', () => fetch('https://example.com/x').then(() => true))",
  "attempt('loopback', () => fetch('http://127.0.0.1:9/x').then(() => true))",
  "attempt('parent-file', () => fetch('../secret.txt').then((r) => r.ok))",
  "attempt('file-url', () => fetch('file:///etc/hosts').then(() => true))",
  // Built at run time: a literal unknown /_sb/ name would stop the page from running at all.
  "attempt('unknown-library', () => fetch('/_s' + 'b/plotly.js').then((r) => r.ok))",
  "attempt('library-folder', () => fetch('/_s' + 'b/licenses/d3-LICENSE').then((r) => r.ok))",
  "fetch('/_sb/chart.js').then((r) => report(r.ok ? 'ALLOWED library' : 'MISSING library'), () => report('MISSING library'))",
  "const w = window.open('https://example.com/popup')",
  "report(w ? 'LEAK window' : 'BLOCKED window')",
  "report(typeof require === 'undefined' && typeof process === 'undefined' ? 'BLOCKED node' : 'LEAK node')",
  "report(typeof window.api === 'undefined' ? 'BLOCKED app' : 'LEAK app')",
  "setTimeout(() => { location.href = 'https://example.com/away'; setTimeout(() => report(location.protocol === 'sb-preview:' ? 'BLOCKED navigate' : 'LEAK navigate'), 500) }, 300)",
  '</script>',
  '```',
].join('\n')

/** The page the "pricing page" script writes, for the HTML preview. */
const PRICING_PAGE_PATH = 'design/pricing-mock.html'
const PRICING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tidepool pricing</title>
<style>
:root{--bg:#f7f6f2;--fg:#191917;--mut:#6b6a63;--card:#fff;--line:#e6e3da;--acc:#0f766e;--acc-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#12161a;--fg:#eef1ee;--mut:#93a09b;--card:#1b2126;--line:#2a3238;--acc:#2dd4bf;--acc-fg:#062a26}}
body{margin:0;background:var(--bg);color:var(--fg);font-family:Georgia,serif;padding:26px 30px}
nav{display:flex;align-items:center;gap:18px;font:12px system-ui,sans-serif;color:var(--mut);margin-bottom:28px}
nav b{font:700 16px Georgia,serif;color:var(--fg)}
nav .cta{margin-left:auto;background:var(--fg);color:var(--bg);padding:5px 11px;border-radius:999px;font-weight:600}
h1{font-size:30px;line-height:1.15;margin:0 0 8px;font-weight:600}
p.lede{font:13px system-ui,sans-serif;color:var(--mut);max-width:420px;margin:0 0 18px}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;font-family:system-ui,sans-serif}
.plan{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px}
.plan.hi{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
.plan h2{font-size:12px;margin:0}.plan .pr{font:28px Georgia,serif;margin:8px 0 2px}
.plan .pr small{font:11.5px system-ui,sans-serif;color:var(--mut)}
.plan ul{list-style:none;padding:0;font-size:11.5px;line-height:1.9;color:var(--fg)}
.plan li::before{content:"\\2713";color:var(--acc);margin-right:7px}
.plan .b{display:block;text-align:center;font-size:12px;font-weight:600;padding:7px;border-radius:8px;border:1px solid var(--line)}
.plan.hi .b{background:var(--acc);color:var(--acc-fg);border-color:var(--acc)}
</style>
</head>
<body>
<nav><b>Tidepool</b><span>Product</span><span>Docs</span><span>Pricing</span><span class="cta">Start free</span></nav>
<h1>Pay for the tide,<br>not the ocean.</h1>
<p class="lede">Every plan includes unlimited projects and the full API. Pick the seats and history you need.</p>
<div class="plans">
<div class="plan"><h2>Solo</h2><div class="pr">$0 <small>/ month</small></div><ul><li>1 seat</li><li>7 day history</li></ul><span class="b">Start free</span></div>
<div class="plan hi"><h2>Team</h2><div class="pr">$24 <small>/ seat / month</small></div><ul><li>Up to 25 seats</li><li>90 day history</li></ul><span class="b">Start a trial</span></div>
<div class="plan"><h2>Scale</h2><div class="pr">Custom</div><ul><li>Unlimited seats</li><li>Unlimited history</li></ul><span class="b">Talk to us</span></div>
</div>
</body>
</html>
`

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
      session.running = this.guard(
        threadId,
        session,
        session.running.then(() => {
          const index = session.queued.indexOf(entry)
          if (index < 0) return
          session.queued.splice(index, 1)
          if (entry.id) session.onEvent({ type: 'turn.dequeued', threadId, messageId: entry.id, reason: 'started' })
          return this.run(threadId, session, message)
        }),
      )
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
    // A real adapter reports usage as the turn streams, so the composer's
    // context ring shows in the screenshots, running and idle.
    session.onEvent({ type: 'context_window', threadId, usedTokens: 158_000, maxTokens: 200_000 })
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
      await this.say(
        threadId,
        turn,
        'Plan mode blocks writes. Switch to Sandbox or Accept Edits and I will apply the change.',
      )
    } else if (/reply to the review/i.test(message)) {
      await this.say(threadId, turn, 'All three are fixed. I will reply on each conversation and resolve it.')
      if (turn.cancelled) return
      const card: HostWriteCard = {
        action: 'reply',
        agentLabel: agentLabel(toAgentProvider(this.provider)),
        host: 'bitbucket',
        prLabel: 'ssg-bot-v2 #612',
        target: { repository: 'geoiq/ssg-bot-v2', number: 612 },
        url: null,
        location: 'sync/worker.py:86',
        quote: {
          author: 'pankaj',
          body: 'Cap the jitter too. With 20 % on top of a 300 s cap, two workers can still meet at the ceiling.',
        },
        replyText:
          'Done in a1b2c3d: the jitter is applied before the cap in next_delay, so the ceiling stays 300 s. test_cap_includes_jitter covers it.',
        suggestResolve: true,
        maxChars: AGENT_REPLY_MAX_CHARS,
      }
      const requestId = `demo_req_${++this.seq}`
      const decision = await new Promise<ApprovalDecision | 'cancelled'>((resolve) => {
        session.approvals.set(requestId, resolve)
        emit({
          type: 'request.opened',
          threadId,
          requestId,
          requestType: 'tool',
          toolName: 'mcp__switchboard__reply_to_conversation',
          detail: hostWriteDetail(card),
          hostWrite: card,
        })
      })
      session.approvals.delete(requestId)
      session.onEvent({
        type: 'request.closed',
        threadId,
        requestId,
        decision: decision === 'cancelled' ? 'deny' : decision,
      })
      if (decision === 'cancelled') return
      await this.say(
        threadId,
        turn,
        decision === 'approve' ? 'Replied on worker.py:86.' : 'Left that conversation for you.',
      )
    } else if (/raise a pull request|open a pull request/i.test(message)) {
      await this.say(threadId, turn, 'Pushed feat/sync-jitter. I will open the pull request through Switchboard.')
      if (turn.cancelled) return
      const card: HostWriteCard = {
        action: 'create',
        agentLabel: agentLabel(toAgentProvider(this.provider)),
        host: 'bitbucket',
        prLabel: 'geoiq/ssg-bot-v2',
        target: { repository: 'geoiq/ssg-bot-v2', number: null },
        url: null,
        location: null,
        quote: null,
        create: {
          repoLabel: 'geoiq/ssg-bot-v2',
          sourceBranch: 'feat/sync-jitter',
          targetBranch: 'main',
          title: 'Cap the sync backoff jitter at the ceiling',
          description:
            'The jitter is applied before the 300 s cap in next_delay, so two workers can no longer meet above it.\n\n- test_cap_includes_jitter covers the ceiling\n- the retry log line names the delay',
          draft: false,
        },
        maxChars: PR_DESCRIPTION_MAX_CHARS,
      }
      const requestId = `demo_req_${++this.seq}`
      const decision = await new Promise<ApprovalDecision | 'cancelled'>((resolve) => {
        session.approvals.set(requestId, resolve)
        emit({
          type: 'request.opened',
          threadId,
          requestId,
          requestType: 'tool',
          toolName: 'mcp__switchboard__create_pull_request',
          detail: hostWriteDetail(card),
          hostWrite: card,
        })
      })
      session.approvals.delete(requestId)
      session.onEvent({
        type: 'request.closed',
        threadId,
        requestId,
        decision: decision === 'cancelled' ? 'deny' : decision,
      })
      if (decision === 'cancelled') return
      await this.say(
        threadId,
        turn,
        decision === 'approve' ? 'Opened it; it is linked to this chat.' : 'Nothing was opened.',
      )
    } else if (/draft a review/i.test(message)) {
      await this.say(threadId, turn, 'I read the diff. Here is a draft with three line comments; the verdict is yours.')
      if (turn.cancelled) return
      const card: HostWriteCard = {
        action: 'review',
        agentLabel: agentLabel(toAgentProvider(this.provider)),
        host: 'github',
        prLabel: 'switchboard #161',
        target: { repository: 'tejasnafde/switchboard', number: 161 },
        url: null,
        location: null,
        quote: null,
        review: DEMO_REVIEW,
        maxChars: AGENT_REPLY_MAX_CHARS,
      }
      const requestId = `demo_req_${++this.seq}`
      const decision = await new Promise<ApprovalDecision | 'cancelled'>((resolve) => {
        session.approvals.set(requestId, resolve)
        emit({
          type: 'request.opened',
          threadId,
          requestId,
          requestType: 'tool',
          toolName: 'mcp__switchboard__draft_review',
          detail: hostWriteDetail(card),
          hostWrite: card,
        })
      })
      session.approvals.delete(requestId)
      session.onEvent({
        type: 'request.closed',
        threadId,
        requestId,
        decision: decision === 'cancelled' ? 'deny' : decision,
      })
      if (decision === 'cancelled') return
      await this.say(threadId, turn, decision === 'approve' ? 'Your review is on #161.' : 'Nothing was posted.')
    } else if (/\brun\b/i.test(message)) {
      await this.say(threadId, turn, 'Running the auth tests to confirm the fix.')
      // Interrupted before the approval opened: registering it now would
      // leave a promise nothing resolves, and a queued turn behind it.
      if (turn.cancelled) return
      const requestId = `demo_req_${++this.seq}`
      const decision = await new Promise<ApprovalDecision | 'cancelled'>((resolve) => {
        session.approvals.set(requestId, resolve)
        emit({
          type: 'request.opened',
          threadId,
          requestId,
          requestType: 'command',
          toolName: 'Bash',
          detail: 'npm test',
        })
      })
      session.approvals.delete(requestId)
      // Close it even when cancelled, or the registry keeps replaying an
      // approval nobody can answer.
      session.onEvent({
        type: 'request.closed',
        threadId,
        requestId,
        decision: decision === 'cancelled' ? 'deny' : decision,
      })
      if (decision === 'cancelled') return
      if (decision === 'approve') {
        await this.tool(
          threadId,
          turn,
          'Bash',
          { command: 'npm test' },
          'ok 1 - exchanges an OAuth code once\nok 2 - rejects an expired state token',
        )
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
      emit({
        type: 'content',
        threadId,
        messageId: `demo_think_${++this.seq}`,
        streamKind: 'reasoning',
        text: 'Weighing where the order could break.',
      })
      await sleep(300)
      await this.say(threadId, turn, 'Interim note: checking the reload path first.')
      await this.tool(threadId, turn, 'Bash', { command: 'sleep 61' }, 'ok', undefined, LONG_TOOL_MS)
      await this.say(threadId, turn, 'Final answer: the order holds.')
    } else if (/\bdraw\b/i.test(message)) {
      await this.say(threadId, turn, VISUALS_REPLY)
    } else if (/\btall live page\b/i.test(message)) {
      await this.say(threadId, turn, LIVE_TALL_REPLY)
    } else if (/\blive page\b/i.test(message)) {
      await this.say(threadId, turn, LIVE_PAGES_REPLY)
    } else if (/\blive probe\b/i.test(message)) {
      await this.say(threadId, turn, LIVE_PROBE_REPLY)
    } else if (/pricing page/i.test(message)) {
      await this.say(threadId, turn, 'Here is a first pass, one self-contained file that follows the system theme.')
      const filePath = join(session.cwd, PRICING_PAGE_PATH)
      await this.tool(
        threadId,
        turn,
        'Write',
        { file_path: filePath, content: PRICING_PAGE_HTML },
        'File written',
        () => {
          mkdirSync(dirname(filePath), { recursive: true })
          writeFileSync(filePath, PRICING_PAGE_HTML)
        },
      )
      await this.say(threadId, turn, `Open \`${PRICING_PAGE_PATH}\` to see it. The Team plan is highlighted.`)
    } else if (/subagents/i.test(message)) {
      await this.runSubagents(threadId, turn)
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
   * Two subagents in parallel: one finishes with a report, one fails on its
   * last step. Their steps carry the Agent call as `parentToolCallId`, as the
   * Claude adapter stamps them.
   */
  private async runSubagents(threadId: string, turn: DemoTurn): Promise<void> {
    const { session } = turn
    await this.say(
      threadId,
      turn,
      "I'll split this: one subagent patches the lockfile and tests, one audits the mobile app's dependencies.",
    )
    const lockfile = `demo_agent_${++this.seq}`
    const mobile = `demo_agent_${++this.seq}`
    for (const [toolId, input] of [
      [lockfile, { description: 'Security updates for dependabot PRs', model: 'haiku', prompt: 'Combine the PRs.' }],
      [mobile, { description: 'Audit apps/mobile dependencies', model: 'sonnet', prompt: 'Audit the deps.' }],
    ] as const) {
      session.onEvent({ type: 'tool.started', threadId, toolId, toolName: 'Agent', input })
      this.record(session, 'assistant', [{ type: 'tool_use', id: toolId, name: 'Agent', input }])
    }
    const step = async (parent: string, toolName: string, input: unknown, output: string, isError = false) => {
      if (turn.cancelled) return
      const toolId = `demo_tool_${++this.seq}`
      session.onEvent({ type: 'tool.started', threadId, toolId, toolName, input, parentToolCallId: parent })
      await this.pause(turn, 60)
      session.onEvent({
        type: 'tool.completed',
        threadId,
        toolId,
        output,
        parentToolCallId: parent,
        ...(isError ? { isError } : {}),
      })
      return toolId
    }
    const notice = (toolUseId: string | undefined, summary: string) => {
      if (!toolUseId || turn.cancelled) return
      session.onEvent({
        type: 'task.notification',
        threadId,
        messageId: `task_demo_${++this.seq}`,
        taskId: `b${this.seq}`,
        status: 'completed',
        summary,
        toolUseId,
        at: Date.now(),
      })
    }
    await step(lockfile, 'Grep', { pattern: '(tinypool|vitest|@vitest/mocker)@[0-9.]+' }, 'package-lock.json')
    await step(mobile, 'Read', { file_path: 'apps/mobile/package.json' }, '{ "name": "mobile" }')
    for (const file of [
      'package-lock.json',
      'package.json',
      'vitest.config.ts',
      'tests/unit/terminal-registry-env.test.ts',
    ])
      await step(lockfile, 'Read', { file_path: file }, 'ok')
    await step(mobile, 'Bash', { command: 'npm audit --prefix apps/mobile --json' }, '{ "vulnerabilities": {} }')
    const checks = await step(lockfile, 'Bash', { command: 'npm ls tinypool', run_in_background: true }, 'started')
    const typecheck = await step(lockfile, 'Bash', { command: 'npm run typecheck', run_in_background: true }, 'started')
    const format = await step(lockfile, 'Bash', { command: 'npx oxfmt', run_in_background: true }, 'started')
    notice(checks, 'Background command "Check tinypool and run unit tests" completed (exit code 0)')
    notice(typecheck, 'Background command "npm run typecheck 2>&1 | tail -5" completed (exit code 0)')
    notice(
      format,
      'Background command "cd /repo && npx oxfmt tests/unit/terminal-registry-*.test.ts" completed (exit code 0)',
    )
    await step(mobile, 'Bash', { command: 'npm ls --prefix apps/mobile expo' }, 'expo@57.0.0')
    await step(mobile, 'Read', { file_path: 'apps/mobile/app.json' }, '{ "expo": {} }')
    await step(
      mobile,
      'Bash',
      { command: 'npx expo-doctor' },
      'Exit code 1\nCheck for app config fields that may not be synced in a non-CNG project\n1 check failed, 14 passed.',
      true,
    )
    if (turn.cancelled) return
    session.onEvent({
      type: 'tool.completed',
      threadId,
      toolId: mobile,
      output: '<tool_use_error>expo-doctor exited 1</tool_use_error>',
      isError: true,
    })
    await step(lockfile, 'Bash', { command: 'git push -u origin chore/security-updates' }, 'pushed')
    if (turn.cancelled) return
    session.onEvent({
      type: 'tool.completed',
      threadId,
      toolId: lockfile,
      output:
        'Combined dependabot PRs **#292-#298** into one lockfile change on **chore/security-updates**. Typecheck clean, 412 tests pass.\nagentId: a1 (use SendMessage to continue this agent)\n<usage>subagent_tokens: 1200\ntool_uses: 11\nduration_ms: 362000</usage>',
    })
    await this.say(threadId, turn, 'The lockfile change is pushed. The mobile audit stopped at expo-doctor.')
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
    return SKILLS[this.provider] ?? []
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

const ALL_EFFORT: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The catalog the picker gets in a demo launch, instead of probing the real
 * CLI with this machine's account. Claude's is shaped like the live list (a
 * `default` row, then the models, each with its effort levels), so the
 * composer's effort control shows in recordings and screenshots.
 */
export function demoCatalog(agentType: AgentProvider): ModelOption[] {
  if (agentType !== 'claude-code') return []
  return [
    { id: 'default', label: 'Default (recommended)', tier: 'balanced', effortLevels: ALL_EFFORT },
    ...CLAUDE_MODELS.map((m) => ({ ...m, effortLevels: m.tier === 'fast' ? [] : ALL_EFFORT })),
  ]
}

const MINUTE = 60_000

/**
 * Canned usage for the Accounts page, so a demo launch never reads a real
 * credential. Times count from `SB_DEMO_NOW` when set, which the visual
 * suite pins to its frozen renderer clock.
 */
export function demoUsage(id: string, agentType: AgentType): ProviderUsage {
  const now = Number(process.env.SB_DEMO_NOW) || Date.now()
  const reading = (status: ProviderUsage['status'], windows: UsageWindow[], message?: string): ProviderUsage => ({
    instanceId: id,
    agentType,
    status,
    plan: null,
    account: null,
    windows,
    overage: [],
    fetchedAtMs: now,
    ...(message ? { message } : {}),
  })
  const pair = (session: number, sessionReset: number, weekly: number, weeklyReset: number) => [
    buildWindow({
      id: 'five_hour',
      label: '5-hour session',
      kind: 'session',
      percent: session,
      resetsAtMs: now + sessionReset * MINUTE,
      windowMinutes: 300,
    }),
    buildWindow({
      id: 'seven_day',
      label: 'Weekly',
      kind: 'weekly',
      percent: weekly,
      resetsAtMs: now + weeklyReset * MINUTE,
      windowMinutes: 10080,
    }),
  ]
  if (agentType === 'opencode') {
    return reading(
      'not-applicable',
      [],
      'OpenCode runs on your own provider API keys, so there is no subscription quota to report.',
    )
  }
  if (id.endsWith('-personal')) return reading('unauthenticated', [], 'the sign-in expired after 30 days without use')
  if (id.endsWith('-work')) return reading('ok', pair(1, 280, 0, 6 * 1440))
  if (id.endsWith('-limit')) {
    // A Codex account at its 5-hour limit with two banked resets, so the
    // Accounts page offers "Use reset". Expiries sit at midday so the date
    // reads the same in every timezone the suite runs in.
    const [session, weekly] = pair(100, 232, 72, 3 * 1440 + 240)
    const midday = (days: number) => Math.floor(now / 86_400_000 + days) * 86_400_000 + 12 * 3_600_000
    return {
      ...reading('ok', [{ ...session, severity: 'critical', reached: true }, weekly]),
      resetCredits: {
        availableCount: 2,
        credits: [
          { id: 'demo-reset-b', expiresAtMs: midday(34), status: 'available', title: 'Weekly limit reset' },
          { id: 'demo-reset-a', expiresAtMs: midday(19), status: 'available', title: 'Weekly limit reset' },
        ],
      },
    }
  }
  if (agentType === 'codex') return reading('ok', pair(18, 182, 9, 3 * 1440))
  return reading('ok', pair(42, 134, 81, 2 * 1440))
}
