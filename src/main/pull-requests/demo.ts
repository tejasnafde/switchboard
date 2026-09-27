/**
 * Scripted pull requests for SB_DEMO_ADAPTER=1 (the tour recorder and the
 * visual regression harness): the mock's data, no network, no credentials.
 * Times count back from SB_DEMO_NOW so the frozen renderer clock labels
 * them the same on every run.
 */
import {
  mergeBlockers,
  rollupChecks,
  type PrChangedFile,
  type PrCheck,
  type PrConversation,
  type PrDetail,
  type PrPerson,
  type PrRef,
  type PrReviewer,
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

const REPOS: Record<string, RepoRef> = {
  bot: { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2' },
  retail: { host: 'bitbucket', owner: 'geoiq', name: 'retailiq' },
  doctor: { host: 'bitbucket', owner: 'geoiq', name: 'ssg-doctor' },
  switchboard: { host: 'github', owner: 'tejasnafde', name: 'switchboard' },
}

function check(name: string, state: PrCheck['state'], durationMs: number | null): PrCheck {
  return { id: name, name, state, description: null, url: null, durationMs }
}

interface Scripted {
  summary: PrSummary
  description: string
  activity: PrDetail['activity']
  checkList: PrCheck[]
  files: PrChangedFile[]
  conversations: PrConversation[]
}

function file(path: string, additions: number, deletions: number, patch = ''): PrChangedFile {
  return { path, oldPath: null, status: deletions === 0 && !patch ? 'added' : 'modified', additions, deletions, binary: false, truncated: false, hunks: parseHunks(patch).hunks }
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
    checks: rollupChecks([]),
    reviewers: [],
    approvals: { given: 0, required: null },
    viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false },
    projectPaths: [],
    ...over,
  })
  const reviewer = (p: PrPerson, state: PrReviewer['state'], requested = true): PrReviewer => ({ person: p, state, requested })

  const botChecks = [check('lint', 'success', 62_000), check('unit', 'success', 220_000), check('integration', 'failure', null), check('build image', 'success', 131_000)]
  const botConversations: PrConversation[] = [
    {
      id: 'c1', path: 'sync/worker.py', line: 86, side: 'new', resolved: false, outdated: false,
      comments: [
        { id: 'c1a', author: PANKAJ, body: 'Cap the jitter too. With 20 % on top of a 300 s cap, two workers can still meet at the ceiling.', createdAt: now - 2 * HOUR, url: null },
      ],
    },
    {
      id: 'c2', path: 'sync/worker.py', line: 111, side: 'new', resolved: false, outdated: false,
      comments: [{ id: 'c2a', author: PANKAJ, body: 'Log the delay as well, or the retry line says nothing about the backoff.', createdAt: now - 2 * HOUR, url: null }],
    },
    {
      id: 'c3', path: 'tests/test_worker.py', line: 14, side: 'new', resolved: false, outdated: false,
      comments: [{ id: 'c3a', author: BACKEND, body: 'This test sleeps for real; use the fake clock.', createdAt: now - 40 * MIN, url: null }],
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
    checks: rollupChecks(botChecks),
    reviewers: [reviewer(AKSHAYA, 'approved'), reviewer(PANKAJ, 'changes_requested'), reviewer(BACKEND, 'commented', false)],
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
    reviewers: [reviewer(ME, 'pending'), reviewer(PANKAJ, 'commented')],
    approvals: { given: 0, required: 1 },
    viewer: { isAuthor: false, isRequestedReviewer: true, hasReviewed: false },
  })

  const retailChecks = [check('lint', 'success', 48_000), check('export tests', 'pending', null)]
  const retail = base({ ...REPOS.retail, number: 88 }, {
    title: 'PowerBI recon export', sourceBranch: 'feat/powerbi-recon', updatedAt: now - 2 * HOUR,
    additions: 96, deletions: 12, changedFiles: 4, checks: rollupChecks(retailChecks),
    reviewers: [reviewer(AKSHAYA, 'pending')], approvals: { given: 0, required: null },
  })
  const doctorChecks = [check('lint', 'success', 51_000), check('unit', 'success', 97_000)]
  const doctor = base({ ...REPOS.doctor, number: 40 }, {
    title: 'Doctor alert dedupe', sourceBranch: 'fix/alert-dedupe', updatedAt: now - 5 * HOUR,
    additions: 38, deletions: 9, changedFiles: 3, checks: rollupChecks(doctorChecks),
    reviewers: [reviewer(PANKAJ, 'pending'), reviewer(BACKEND, 'pending')], approvals: { given: 0, required: 2 },
  })
  const readyChecks = [check('Test (ubuntu-latest)', 'success', 211_000), check('Test (windows-latest)', 'success', 294_000)]
  const ready = base({ ...REPOS.switchboard, number: 159 }, {
    title: 'Retry settings.json on Windows', sourceBranch: 'fix/settings-file-windows-rename', updatedAt: now - 6 * HOUR,
    additions: 475, deletions: 44, changedFiles: 10, checks: rollupChecks(readyChecks),
    reviewers: [reviewer(AKSHAYA, 'approved')], approvals: { given: 1, required: 1 },
  })
  const merged = (number: number, title: string, ago: number): PrSummary => base({ ...REPOS.switchboard, number }, {
    title, state: 'merged', mergedAt: now - ago, updatedAt: now - ago, checks: rollupChecks(readyChecks),
    reviewers: [reviewer(AKSHAYA, 'approved')], approvals: { given: 1, required: 1 },
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
        file('sync/worker.py', 42, 9, WORKER_PATCH),
        file('sync/backoff.py', 31, 0, '@@ -0,0 +1,3 @@\n+def next_delay(attempt: int, base: float, cap: float) -> float:\n+    """Exponential backoff, capped."""\n+    return min(cap, base * 2 ** attempt)'),
        file('sync/config.py', 4, 1, '@@ -10,3 +10,6 @@\n RETRY = True\n-RETRY_SECONDS = 30\n+RETRY_BASE = 1.0\n+RETRY_CAP = 300.0\n+RETRY_JITTER = 0.2'),
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
    plain(ready, readyChecks),
    plain(merged(157, 'Project scopes', 2 * DAY), readyChecks),
    plain(merged(158, 'Open settings as JSON', 1 * DAY), readyChecks),
  ]
}

class DemoProvider implements PullRequestProvider {
  constructor(readonly host: 'github' | 'bitbucket', private readonly now: () => number) {}

  private all(): Scripted[] {
    return scripted(this.now()).filter((s) => s.summary.ref.host === this.host)
  }

  private find(ref: PrRef): Scripted {
    const hit = this.all().find((s) => s.summary.ref.number === ref.number && s.summary.ref.name === ref.name)
    if (!hit) throw new PrHostError({ kind: 'not_found', host: this.host, message: 'No such demo pull request.' })
    return hit
  }

  async list(repos: RepoRef[]): Promise<RepoListResult[]> {
    const all = this.all()
    return repos.map((repo) => ({ repo, prs: all.filter((s) => s.summary.ref.name === repo.name).map((s) => s.summary), error: null }))
  }

  async detail(ref: PrRef): Promise<PrDetail> {
    const s = this.find(ref)
    return { ...s.summary, description: s.description, headSha: 'a1b2c3d', mergeBlockers: mergeBlockers(s.summary), activity: s.activity, checkList: s.checkList }
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
}

export function createDemoPullRequestService(): PullRequestService {
  const now = () => Number(process.env.SB_DEMO_NOW) || Date.now()
  const remotes: Record<string, string> = {
    '/demo/ssg-bot-v2': 'git@bitbucket.org:geoiq/ssg-bot-v2.git',
    '/demo/retailiq': 'https://bitbucket.org/geoiq/retailiq.git',
    '/demo/ssg-doctor': 'git@bitbucket.org:geoiq/ssg-doctor.git',
    '/demo/switchboard': 'https://github.com/tejasnafde/switchboard.git',
  }
  const github = new DemoProvider('github', now)
  const bitbucket = new DemoProvider('bitbucket', now)
  return new PullRequestService({
    listProjects: () => Object.keys(remotes),
    readRemotes: async (path) => `origin\t${remotes[path]} (fetch)\norigin\t${remotes[path]} (push)`,
    github: () => github,
    bitbucket: () => bitbucket,
    bitbucketState: () => ({ state: 'configured', email: 'tejas@example.com' }),
    now,
  })
}
