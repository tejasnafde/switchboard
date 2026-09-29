/**
 * Scripted pull requests for SB_DEMO_ADAPTER=1 (the tour recorder and the
 * visual regression harness): the mock's data, no network, no credentials.
 * Times count back from SB_DEMO_NOW so the frozen renderer clock labels
 * them the same on every run.
 *
 * Writes never leave the process: each is recorded on
 * `globalThis.__sbDemoPrWrites` (the e2e reads it from the main process) and
 * applied to an in-memory overlay, so the screens show the result.
 */
import type { CreatedPr, CreatePrInput } from '@shared/agent-pr-create'
import type { InlineCommentInput, SubmitReviewInput } from '@shared/pull-request-writes'
import {
  mergeBlockers,
  rollupChecks,
  type MergeStrategy,
  type PrActivity,
  type PrChangedFile,
  type PrCheck,
  type PrComment,
  type PrConversation,
  type PrDetail,
  type PrPerson,
  type PrRef,
  type PrReviewer,
  type PrReviewerCandidate,
  type PrSummary,
  type RepoRef,
} from '@shared/pull-requests'
import { parseHunks } from '@shared/unified-diff'
import { PrHostError, type PullRequestProvider, type RepoListResult } from './provider'
import { PullRequestService } from './service'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const person = (login: string, displayName = login): PrPerson => ({ login, displayName, avatarUrl: null })
const ME = person('tejas', 'Tejas')
const PANKAJ = person('pankaj')
const AKSHAYA = person('akshaya')
const BACKEND = person('backend')
const BARATH = person('barath')
/** The workspace members / collaborators the demo token can see. */
const CANDIDATES = [PANKAJ, AKSHAYA, BACKEND, BARATH]

/** Bitbucket reviewer ids are account uuids (the write validation refuses anything else); GitHub's are logins. */
const BB_UUID: Record<string, string> = {
  tejas: '{00000000-0000-4000-8000-000000000001}',
  pankaj: '{00000000-0000-4000-8000-000000000002}',
  akshaya: '{00000000-0000-4000-8000-000000000003}',
  backend: '{00000000-0000-4000-8000-000000000004}',
  barath: '{00000000-0000-4000-8000-000000000005}',
}
const reviewerId = (host: RepoRef['host'], p: PrPerson): string => (host === 'bitbucket' ? BB_UUID[p.login] : p.login)

const REPOS: Record<string, RepoRef> = {
  bot: { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2' },
  retail: { host: 'bitbucket', owner: 'geoiq', name: 'retailiq' },
  doctor: { host: 'bitbucket', owner: 'geoiq', name: 'ssg-doctor' },
  switchboard: { host: 'github', owner: 'tejasnafde', name: 'switchboard' },
}

function check(name: string, state: PrCheck['state'], durationMs: number | null): PrCheck {
  // Failed demo checks re-run on GitHub (an Actions run); Bitbucket's never do.
  return { id: name, name, state, description: null, url: null, durationMs, rerunId: state === 'failure' ? '9001' : null }
}

interface Scripted {
  summary: PrSummary
  description: string
  activity: PrDetail['activity']
  checkList: PrCheck[]
  files: PrChangedFile[]
  conversations: PrConversation[]
}

function file(path: string, additions: number, deletions: number, patch = '', conflicted = false): PrChangedFile {
  const status = conflicted ? 'conflicted' : deletions === 0 && !patch ? 'added' : 'modified'
  return { path, oldPath: null, status, additions, deletions, binary: false, truncated: false, hunks: parseHunks(patch).hunks }
}

const WORKER_PATCH = [
  '@@ -80,12 +80,24 @@ class SyncWorker:',
  '     def run_once(self, attempt: int) -> None:',
  '         if not self.lease.held():',
  '             return None',
  '         self.metrics.attempts.inc()',
  '-        time.sleep(30)',
  '+        delay = next_delay(attempt, base=1.0, cap=300.0)',
  '+        delay += random.uniform(0, delay * 0.2)',
  '+        time.sleep(delay)',
  '+        return self.poll()',
  '@@ -98,6 +110,9 @@ class SyncWorker:',
  '     def on_error(self, err: Exception) -> None:',
  '+        log.warning("sync retry", extra={"attempt": self.attempt})',
  '         self.attempt += 1',
].join('\n')

function scripted(now: number): Scripted[] {
  const base = (ref: PrRef, over: Partial<PrSummary>): PrSummary => ({
    ref,
    title: '',
    url: ref.host === 'github'
      ? `https://github.com/${ref.owner}/${ref.name}/pull/${ref.number}`
      : `https://bitbucket.org/${ref.owner}/${ref.name}/pull-requests/${ref.number}`,
    author: ME,
    state: 'open',
    draft: false,
    sourceBranch: 'feature',
    targetBranch: 'main',
    createdAt: now - DAY,
    updatedAt: now - HOUR,
    mergedAt: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    unresolvedConversations: 0,
    mergeConflicts: false,
    conflictedFiles: [],
    checks: rollupChecks([]),
    reviewers: [],
    approvals: { given: 0, required: null },
    viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false, hasCommented: false },
    projectPaths: [],
    ...over,
    authorId: reviewerId(ref.host, over.author ?? ME) ?? null,
  })
  const reviewer = (host: RepoRef['host'], p: PrPerson, state: PrReviewer['state'], requested = true): PrReviewer => ({ id: reviewerId(host, p), person: p, state, requested })
  const bb = (p: PrPerson, state: PrReviewer['state'], requested = true) => reviewer('bitbucket', p, state, requested)
  const gh = (p: PrPerson, state: PrReviewer['state'], requested = true) => reviewer('github', p, state, requested)

  const botChecks = [check('lint', 'success', 62_000), check('unit', 'success', 220_000), check('integration', 'failure', null), check('build image', 'success', 131_000)]
  // Bitbucket comment ids are numbers; the write validation refuses anything else.
  const botConversations: PrConversation[] = [
    {
      id: '101', path: 'sync/worker.py', line: 86, side: 'new', resolved: false, outdated: false,
      comments: [
        { id: '1011', author: PANKAJ, body: 'Cap the jitter too. With 20 % on top of a 300 s cap, two workers can still meet at the ceiling.', createdAt: now - 2 * HOUR, url: null },
      ],
    },
    {
      id: '102', path: 'sync/worker.py', line: 111, side: 'new', resolved: false, outdated: false,
      comments: [{ id: '1021', author: PANKAJ, body: 'Log the delay as well, or the retry line says nothing about the backoff.', createdAt: now - 2 * HOUR, url: null }],
    },
    {
      id: '103', path: 'tests/test_worker.py', line: 14, side: 'new', resolved: false, outdated: false,
      comments: [{ id: '1031', author: BACKEND, body: 'This test sleeps for real; use the fake clock.', createdAt: now - 40 * MIN, url: null }],
    },
  ]
  const bot = base({ ...REPOS.bot, number: 612 }, {
    title: 'Jittered backoff for the SSG sync worker',
    sourceBranch: 'feat/sync-backoff',
    createdAt: now - 3 * HOUR,
    updatedAt: now - 20 * MIN,
    additions: 151,
    deletions: 16,
    changedFiles: 7,
    unresolvedConversations: 3,
    mergeConflicts: true,
    conflictedFiles: ['sync/worker.py', 'sync/config.py'],
    checks: rollupChecks(botChecks),
    reviewers: [bb(AKSHAYA, 'approved'), bb(PANKAJ, 'changes_requested'), bb(BACKEND, 'commented', false)],
    approvals: { given: 1, required: 2 },
  })

  const sbConversations: PrConversation[] = [
    {
      id: 's1', path: 'src/main/db/kanban.ts', line: 88, side: 'new', resolved: false, outdated: false,
      comments: [{ id: 's1a', author: PANKAJ, body: 'A cap of 0 reads as "no cap" here. Is that on purpose?', createdAt: now - 50 * MIN, url: null }],
    },
    {
      id: 's2', path: 'src/renderer/components/kanban/CardModal.tsx', line: 141, side: 'new', resolved: false, outdated: false,
      comments: [{ id: 's2a', author: AKSHAYA, body: 'The input accepts negative numbers.', createdAt: now - 30 * MIN, url: null }],
    },
    {
      id: 's3', path: 'src/shared/kanban.ts', line: 12, side: 'new', resolved: true, outdated: false,
      comments: [{ id: 's3a', author: PANKAJ, body: 'Name it costCapUsd to match the column.', createdAt: now - 55 * MIN, url: null }],
    },
  ]
  const sbChecks = [check('Test (ubuntu-latest)', 'success', 206_000), check('Test (macos-14)', 'success', 153_000), check('Visual regressions (macOS)', 'success', 158_000)]
  const sb = base({ ...REPOS.switchboard, number: 161 }, {
    title: 'Kanban card cost cap',
    author: BACKEND,
    sourceBranch: 'feat/card-cost-cap',
    createdAt: now - HOUR,
    updatedAt: now - 30 * MIN,
    additions: 212,
    deletions: 34,
    changedFiles: 9,
    unresolvedConversations: 2,
    checks: rollupChecks(sbChecks),
    reviewers: [gh(ME, 'pending'), gh(PANKAJ, 'commented')],
    approvals: { given: 0, required: 1 },
    viewer: { isAuthor: false, isRequestedReviewer: true, hasReviewed: false, hasCommented: false },
  })

  const retailChecks = [check('lint', 'success', 48_000), check('export tests', 'pending', null)]
  const retail = base({ ...REPOS.retail, number: 88 }, {
    title: 'PowerBI recon export', sourceBranch: 'feat/powerbi-recon', updatedAt: now - 2 * HOUR,
    additions: 96, deletions: 12, changedFiles: 4, checks: rollupChecks(retailChecks),
    reviewers: [bb(AKSHAYA, 'pending')], approvals: { given: 0, required: null },
  })
  const doctorChecks = [check('lint', 'success', 51_000), check('unit', 'success', 97_000)]
  const doctor = base({ ...REPOS.doctor, number: 40 }, {
    title: 'Doctor alert dedupe', sourceBranch: 'fix/alert-dedupe', updatedAt: now - 5 * HOUR,
    additions: 38, deletions: 9, changedFiles: 3, checks: rollupChecks(doctorChecks),
    reviewers: [bb(PANKAJ, 'pending'), bb(BACKEND, 'pending')], approvals: { given: 0, required: 2 },
  })
  const alertsChecks = [check('lint', 'success', 44_000), check('unit', 'success', 88_000)]
  const alerts = base({ ...REPOS.doctor, number: 42 }, {
    title: 'Alert digest for quiet hours', author: PANKAJ, sourceBranch: 'feat/alert-digest', updatedAt: now - 3 * HOUR,
    additions: 64, deletions: 5, changedFiles: 3, checks: rollupChecks(alertsChecks),
    reviewers: [bb(AKSHAYA, 'pending'), bb(ME, 'commented', false)], approvals: { given: 0, required: 1 },
    viewer: { isAuthor: false, isRequestedReviewer: false, hasReviewed: false, hasCommented: true },
  })
  const readyChecks = [check('Test (ubuntu-latest)', 'success', 211_000), check('Test (windows-latest)', 'success', 294_000)]
  const ready = base({ ...REPOS.switchboard, number: 159 }, {
    title: 'Retry settings.json on Windows', sourceBranch: 'fix/settings-file-windows-rename', updatedAt: now - 6 * HOUR,
    additions: 475, deletions: 44, changedFiles: 10, checks: rollupChecks(readyChecks),
    reviewers: [gh(AKSHAYA, 'approved')], approvals: { given: 1, required: 1 },
  })
  const merged = (number: number, title: string, ago: number): PrSummary => base({ ...REPOS.switchboard, number }, {
    title, state: 'merged', mergedAt: now - ago, updatedAt: now - ago, checks: rollupChecks(readyChecks),
    reviewers: [gh(AKSHAYA, 'approved')], approvals: { given: 1, required: 1 },
  })

  const plain = (summary: PrSummary, checkList: PrCheck[]): Scripted => ({ summary, description: '', activity: [], checkList, files: [], conversations: [] })
  return [
    {
      summary: bot,
      description: 'Replaces the fixed 30 s retry in `SyncWorker.run_once` with jittered exponential backoff, capped at 5 minutes. During the 24 Sep outage, 40 workers retried in lock-step every 30 s and kept the upstream down.',
      activity: [
        { id: 'a1', kind: 'reviewed', actor: PANKAJ, summary: 'requested changes', detail: '2 comments on worker.py', at: now - 2 * HOUR },
        { id: 'a2', kind: 'reviewed', actor: AKSHAYA, summary: 'approved', detail: null, at: now - 2 * HOUR },
        { id: 'a3', kind: 'pushed', actor: ME, summary: 'pushed a commit', detail: 'Cap the jitter before the ceiling', at: now - 45 * MIN },
        { id: 'a4', kind: 'commented', actor: BACKEND, summary: 'commented', detail: 'test_worker.py: "This test sleeps for real; use the fake clock."', at: now - 40 * MIN },
      ],
      checkList: botChecks,
      files: [
        file('sync/worker.py', 42, 9, WORKER_PATCH, true),
        file('sync/backoff.py', 31, 0, '@@ -0,0 +1,3 @@\n+def next_delay(attempt: int, base: float, cap: float) -> float:\n+    """Exponential backoff, capped."""\n+    return min(cap, base * 2 ** attempt)'),
        file('sync/config.py', 4, 1, '@@ -10,3 +10,6 @@\n RETRY = True\n-RETRY_SECONDS = 30\n+RETRY_BASE = 1.0\n+RETRY_CAP = 300.0\n+RETRY_JITTER = 0.2', true),
        file('tests/test_worker.py', 28, 0),
        file('tests/test_backoff.py', 40, 0),
        file('README.md', 5, 0),
        file('CHANGELOG.md', 1, 0),
      ],
      conversations: botConversations,
    },
    {
      summary: sb,
      description: 'Adds a per-card cost cap. A card whose chat spends past its cap stops the agent and moves to Needs input.',
      activity: [
        { id: 'b1', kind: 'opened', actor: BACKEND, summary: 'opened the pull request', detail: null, at: now - HOUR },
        { id: 'b2', kind: 'reviewed', actor: PANKAJ, summary: 'reviewed', detail: '2 comments', at: now - 50 * MIN },
      ],
      checkList: sbChecks,
      files: [
        file('src/main/db/kanban.ts', 44, 6, '@@ -84,6 +84,9 @@ export function updateCard(\n   const row = getCard(id)\n   if (!row) return null\n+  if (patch.costCapUsd !== undefined) {\n+    row.cost_cap_usd = patch.costCapUsd || null\n+  }\n   return saveCard(row)'),
        file('src/renderer/components/kanban/CardModal.tsx', 61, 12),
        file('src/shared/kanban.ts', 8, 2),
      ],
      conversations: sbConversations,
    },
    plain(retail, retailChecks),
    plain(doctor, doctorChecks),
    plain(alerts, alertsChecks),
    plain(ready, readyChecks),
    plain(merged(157, 'Project scopes', 2 * DAY), readyChecks),
    plain(merged(158, 'Open settings as JSON', 1 * DAY), readyChecks),
  ]
}

export interface DemoPrWrite {
  action: string
  ref: PrRef
  input: unknown
}

declare global {
  var __sbDemoPrWrites: DemoPrWrite[] | undefined
  /** e2e only: how long the demo host takes to answer, in ms, so a test can see the loading and pending states. */
  var __sbDemoPrDelayMs: Partial<Record<'list' | 'candidates' | 'write', number>> | undefined
}

async function hostDelay(kind: 'list' | 'candidates' | 'write'): Promise<void> {
  const ms = globalThis.__sbDemoPrDelayMs?.[kind]
  if (ms) await new Promise((resolve) => setTimeout(resolve, ms))
}

const MERGE_STRATEGIES: Record<'github' | 'bitbucket', MergeStrategy[]> = {
  github: ['merge_commit', 'squash', 'rebase'],
  bitbucket: ['merge_commit', 'squash', 'fast_forward'],
}

/** What the recorded writes changed, applied over the scripted data on every read. */
interface Overlay {
  replies: Map<string, PrComment[]>
  resolved: Map<string, boolean>
  threads: Map<number, PrConversation[]>
  activity: Map<number, PrActivity[]>
  merged: Set<number>
  review: Map<number, PrReviewer['state']>
  rerun: Set<string>
  /** Reviewer ids added, and removed, per PR number. */
  added: Map<number, string[]>
  removed: Map<number, string[]>
  declined: Set<number>
}

class DemoProvider implements PullRequestProvider {
  private readonly overlay: Overlay = {
    replies: new Map(), resolved: new Map(), threads: new Map(), activity: new Map(), merged: new Set(), review: new Map(), rerun: new Set(),
    added: new Map(), removed: new Map(), declined: new Set(),
  }
  private seq = 0

  constructor(readonly host: 'github' | 'bitbucket', private readonly now: () => number) {}

  private apply(s: Scripted): Scripted {
    const o = this.overlay
    const n = s.summary.ref.number
    const conversations = [...s.conversations, ...(o.threads.get(n) ?? [])].map((c) => ({
      ...c,
      resolved: o.resolved.get(c.id) ?? c.resolved,
      comments: [...c.comments, ...(o.replies.get(c.id) ?? [])],
    }))
    const checkList = s.checkList.map((c) => (o.rerun.has(`${n}:${c.id}`) ? { ...c, state: 'pending' as const, durationMs: null } : c))
    const verdict = o.review.get(n)
    const host = s.summary.ref.host
    const reviewers = (verdict
      ? [...s.summary.reviewers.filter((r) => r.person.login !== ME.login), { id: reviewerId(host, ME), person: ME, state: verdict, requested: true }]
      : s.summary.reviewers)
      .filter((r) => !(o.removed.get(n) ?? []).includes(r.id ?? ''))
      .concat((o.added.get(n) ?? []).map((id) => ({ id, person: CANDIDATES.find((p) => reviewerId(host, p) === id) ?? person(id), state: 'pending' as const, requested: true })))
    const merged = o.merged.has(n)
    const summary: PrSummary = {
      ...s.summary,
      state: merged ? 'merged' : o.declined.has(n) ? 'closed' : s.summary.state,
      mergedAt: merged ? this.now() : s.summary.mergedAt,
      unresolvedConversations: s.conversations.length > 0 || o.threads.has(n) ? conversations.filter((c) => !c.resolved).length : s.summary.unresolvedConversations,
      checks: rollupChecks(checkList),
      reviewers,
      approvals: { ...s.summary.approvals, given: reviewers.filter((r) => r.state === 'approved').length },
      viewer: verdict
        ? { ...s.summary.viewer, isRequestedReviewer: false, hasReviewed: verdict !== 'commented', hasCommented: verdict === 'commented' }
        : s.summary.viewer,
    }
    return { ...s, summary, conversations, checkList, activity: [...s.activity, ...(o.activity.get(n) ?? [])] }
  }

  private all(): Scripted[] {
    return scripted(this.now()).filter((s) => s.summary.ref.host === this.host).map((s) => this.apply(s))
  }

  private find(ref: PrRef): Scripted {
    const hit = this.all().find((s) => s.summary.ref.number === ref.number && s.summary.ref.name === ref.name)
    if (!hit) throw new PrHostError({ kind: 'not_found', host: this.host, message: 'No such demo pull request.' })
    return hit
  }

  async list(repos: RepoRef[]): Promise<RepoListResult[]> {
    await hostDelay('list')
    const all = this.all()
    return repos.map((repo) => repo.owner === UNSEEN_WORKSPACE
      ? { repo, prs: [], error: { kind: 'not_found', host: this.host, message: 'Bitbucket could not find it, or this account cannot see it.' } }
      : { repo, prs: all.filter((s) => s.summary.ref.name === repo.name).map((s) => s.summary), error: null })
  }

  async detail(ref: PrRef): Promise<PrDetail> {
    const s = this.find(ref)
    return {
      ...s.summary,
      description: s.description,
      headSha: 'a1b2c3d',
      mergeBlockers: mergeBlockers(s.summary),
      mergeStrategies: MERGE_STRATEGIES[this.host],
      activity: s.activity,
      checkList: s.checkList,
      viewerCanManage: s.summary.viewer.isAuthor,
    }
  }

  async files(ref: PrRef): Promise<PrChangedFile[]> {
    return this.find(ref).files
  }

  async conversations(ref: PrRef): Promise<PrConversation[]> {
    return this.find(ref).conversations
  }

  async checks(ref: PrRef): Promise<PrCheck[]> {
    return this.find(ref).checkList
  }

  private async record(action: string, ref: PrRef, input: unknown): Promise<void> {
    await hostDelay('write')
    globalThis.__sbDemoPrWrites ??= []
    globalThis.__sbDemoPrWrites.push({ action, ref, input })
  }

  private mine(body: string): PrComment {
    return { id: String(900_000 + ++this.seq), author: ME, body, createdAt: this.now(), url: null }
  }

  private addThread(ref: PrRef, c: InlineCommentInput): void {
    const list = this.overlay.threads.get(ref.number) ?? []
    list.push({ id: String(900_000 + ++this.seq), path: c.path, line: c.line, side: c.side, resolved: false, outdated: false, comments: [this.mine(c.body)] })
    this.overlay.threads.set(ref.number, list)
  }

  private addActivity(ref: PrRef, summary: string, detail: string | null): void {
    const list = this.overlay.activity.get(ref.number) ?? []
    list.push({ id: `demo-activity-${++this.seq}`, kind: 'commented', actor: ME, summary, detail, at: this.now() })
    this.overlay.activity.set(ref.number, list)
  }

  async reply(ref: PrRef, conversationId: string, body: string): Promise<void> {
    await this.record('reply', ref, { conversationId, body })
    this.overlay.replies.set(conversationId, [...(this.overlay.replies.get(conversationId) ?? []), this.mine(body)])
  }

  async setResolved(ref: PrRef, conversationId: string, resolved: boolean): Promise<void> {
    await this.record(resolved ? 'resolve' : 'unresolve', ref, { conversationId })
    this.overlay.resolved.set(conversationId, resolved)
  }

  async comment(ref: PrRef, body: string): Promise<void> {
    await this.record('comment', ref, { body })
    this.addActivity(ref, 'commented', body)
  }

  async inlineComment(ref: PrRef, comment: InlineCommentInput): Promise<void> {
    await this.record('inline-comment', ref, comment)
    this.addThread(ref, comment)
  }

  async submitReview(ref: PrRef, review: SubmitReviewInput): Promise<void> {
    await this.record('submit-review', ref, review)
    for (const c of review.comments) this.addThread(ref, c)
    const verdict = review.event === 'approve' ? 'approved' : review.event === 'request_changes' ? 'changes_requested' : 'commented'
    this.overlay.review.set(ref.number, verdict)
    this.addActivity(ref, verdict === 'approved' ? 'approved' : verdict === 'changes_requested' ? 'requested changes' : 'reviewed', review.body || null)
  }

  async merge(ref: PrRef, strategy: MergeStrategy, headSha: string): Promise<void> {
    await this.record('merge', ref, { strategy, headSha })
    this.overlay.merged.add(ref.number)
  }

  async rerunCheck(ref: PrRef, check: PrCheck): Promise<void> {
    await this.record('rerun-check', ref, { checkId: check.id, rerunId: check.rerunId })
    this.overlay.rerun.add(`${ref.number}:${check.id}`)
  }

  async reviewerCandidates(): Promise<PrReviewerCandidate[]> {
    await hostDelay('candidates')
    return CANDIDATES.map((p) => ({ id: reviewerId(this.host, p), person: p, kind: 'user', reviewed: 0 }))
  }

  async addReviewer(ref: PrRef, reviewer: string): Promise<void> {
    await this.record('add-reviewer', ref, { reviewer })
    this.overlay.added.set(ref.number, [...(this.overlay.added.get(ref.number) ?? []), reviewer])
    this.overlay.removed.set(ref.number, (this.overlay.removed.get(ref.number) ?? []).filter((id) => id !== reviewer))
  }

  async removeReviewer(ref: PrRef, reviewer: string): Promise<void> {
    await this.record('remove-reviewer', ref, { reviewer })
    this.overlay.removed.set(ref.number, [...(this.overlay.removed.get(ref.number) ?? []), reviewer])
    this.overlay.added.set(ref.number, (this.overlay.added.get(ref.number) ?? []).filter((id) => id !== reviewer))
  }

  async decline(ref: PrRef): Promise<void> {
    await this.record('decline', ref, {})
    this.overlay.declined.add(ref.number)
  }

  async defaultBranch(): Promise<string> {
    return 'main'
  }

  async openPullRequestFor(repo: RepoRef, branch: string): Promise<CreatedPr | null> {
    const hit = this.all().find((s) => s.summary.ref.name === repo.name && s.summary.state === 'open' && s.summary.sourceBranch === branch)
    return hit ? { number: hit.summary.ref.number, url: hit.summary.url } : null
  }

  /** Recorded only: the scripted list stays as it is for the visual harness. */
  async createPullRequest(repo: RepoRef, input: CreatePrInput): Promise<CreatedPr> {
    const number = 900 + ++this.seq
    await this.record('create', { ...repo, number }, input)
    const path = this.host === 'github' ? 'pull' : 'pull-requests'
    return { number, url: `https://${this.host === 'github' ? 'github.com' : 'bitbucket.org'}/${repo.owner}/${repo.name}/${path}/${number}` }
  }
}

/** Its repositories answer 404, like a workspace the token's account has no access to. */
const UNSEEN_WORKSPACE = 'geoiq-staging'

/** `hiddenRepos` is the real table, so the e2e hides a repository the way the app does. */
export function createDemoPullRequestService(hiddenRepos?: () => ReadonlySet<string>): PullRequestService {
  const now = () => Number(process.env.SB_DEMO_NOW) || Date.now()
  const remotes: Record<string, string> = {
    '/demo/ssg-bot-v2': 'git@bitbucket.org:geoiq/ssg-bot-v2.git',
    '/demo/retailiq': 'https://bitbucket.org/geoiq/retailiq.git',
    '/demo/ssg-doctor': 'git@bitbucket.org:geoiq/ssg-doctor.git',
    '/demo/switchboard': 'https://github.com/tejasnafde/switchboard.git',
  }
  // The e2e for hiding repositories: a workspace this account cannot see.
  if (process.env.SB_DEMO_REPO_ERRORS === '1') {
    remotes['/demo/broker-app-stg'] = `git@bitbucket.org:${UNSEEN_WORKSPACE}/geoiq_broker_app_stg.git`
    remotes['/demo/core-stg'] = `git@bitbucket.org:${UNSEEN_WORKSPACE}/geoiqcore_stg.git`
  }
  const github = new DemoProvider('github', now)
  const bitbucket = new DemoProvider('bitbucket', now)
  return new PullRequestService({
    listProjects: () => Object.keys(remotes),
    readRemotes: async (path) => `origin\t${remotes[path]} (fetch)\norigin\t${remotes[path]} (push)`,
    github: () => github,
    bitbucket: () => bitbucket,
    bitbucketState: () => ({ state: 'configured', email: 'tejas@example.com' }),
    hiddenRepos,
    now,
  })
}
