/**
 * The seeded "acme-console" workspace shared by the tour recorder
 * (videos/capture-tour.mjs) and the visual regression suite
 * (e2e/visual-regressions.e2e.mjs): two git repos, sidebar threads across all
 * three providers, kanban cards and remote machines. Needs sqlite3 on PATH.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sql = (value) => (value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`)

function gitCommitAll(cwd, message) {
  const identity = ['-c', 'user.email=demo@switchboard.local', '-c', 'user.name=Switchboard Demo']
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
  execFileSync('git', [...identity, 'add', '.'], { cwd })
  execFileSync('git', [...identity, 'commit', '-qm', message], { cwd })
}

export function makeDemoRepo(projectPath) {
  mkdirSync(join(projectPath, 'src', 'api'), { recursive: true })
  mkdirSync(join(projectPath, 'src', 'components'), { recursive: true })
  mkdirSync(join(projectPath, 'tests'), { recursive: true })
  mkdirSync(join(projectPath, '.switchboard'), { recursive: true })
  writeFileSync(
    join(projectPath, 'package.json'),
    JSON.stringify(
      {
        name: 'acme-console',
        private: true,
        scripts: { test: 'node tests/auth.test.mjs' },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(projectPath, 'src', 'api', 'auth.ts'),
    [
      'export async function exchangeCode(code: string) {',
      "  const response = await fetch('/api/oauth/token', {",
      "    method: 'POST',",
      '    body: JSON.stringify({ code }),',
      '  })',
      '  return response.json()',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(projectPath, 'src', 'api', 'state.ts'),
    [
      'const issued = new Map<string, number>()',
      '',
      'export function verifyState(token: string): boolean {',
      '  const at = issued.get(token)',
      '  return at !== undefined && Date.now() - at < 5 * 60_000',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(projectPath, 'src', 'components', 'LoginButton.tsx'),
    ['export function LoginButton() {', '  return <button>Continue with GitHub</button>', '}', ''].join('\n'),
  )
  writeFileSync(
    join(projectPath, 'tests', 'auth.test.mjs'),
    [
      "console.log('TAP version 13')",
      "console.log('ok 1 - exchanges an OAuth code once')",
      "console.log('ok 2 - rejects an expired state token')",
      "console.log('1..2')",
      '',
    ].join('\n'),
  )
  // Named launch configs for the launch-config scene. Commands are plain
  // printf so the fixture shell produces believable output with no services.
  writeFileSync(
    join(projectPath, '.switchboard', 'launch-config.yaml'),
    [
      'configs:',
      '  default:',
      '    terminals:',
      '      - label: shell',
      '  backend:',
      '    terminals:',
      '      - label: api',
      "        command: printf 'api listening on :3000\\n'",
      '      - label: db',
      "        command: printf 'postgres ready, accepting connections\\n'",
      '      - label: logs',
      "        command: printf '[info] booted in 412 ms\\n'",
      '',
    ].join('\n'),
  )
  gitCommitAll(projectPath, 'Seed demo workspace')
}

export function makeSideRepo(projectPath) {
  mkdirSync(join(projectPath, 'src'), { recursive: true })
  writeFileSync(join(projectPath, 'package.json'), JSON.stringify({ name: 'notes-cli', private: true }, null, 2))
  writeFileSync(join(projectPath, 'src', 'index.ts'), "console.log('notes')\n")
  gitCommitAll(projectPath, 'Seed side project')
}

export function seedDatabase(
  dbPath,
  projectPath,
  sidePath,
  { now = Date.now(), showFileDiffs = true, expandLocalTree = true, linkPullRequest = false } = {},
) {
  const messagePills = JSON.stringify({
    auth_file: { label: 'auth.ts (1-7)', kind: 'file' },
    api_log: { label: 'api (12 lines)', kind: 'terminal' },
  })
  const snapshotA = JSON.stringify([
    {
      path: '/srv/checkout-api',
      name: 'checkout-api',
      sessions: [
        { id: 'remote-1', title: 'Trace webhook retries', agentType: 'claude-code' },
        { id: 'remote-2', title: 'Review deploy diff', agentType: 'codex' },
      ],
    },
  ])
  const snapshotB = JSON.stringify([
    {
      path: '/opt/acme-console',
      name: 'acme-console',
      sessions: [{ id: 'remote-3', title: 'Run release checks', agentType: 'claude-code' }],
    },
  ])
  const tools = (name, input, output) =>
    sql(JSON.stringify([{ id: `${name}-1`, name, input: JSON.stringify(input), output }]))
  const conv = (id, agent, title, createdAgo, updatedAgo, mode, project = projectPath) =>
    `INSERT OR REPLACE INTO conversations (id, project_path, agent_type, title, created_at, updated_at, runtime_mode, sidebar_role) VALUES (${sql(id)}, ${sql(project)}, ${sql(agent)}, ${sql(title)}, ${now - createdAgo}, ${now - updatedAgo}, ${sql(mode)}, 'managed');`
  const msg = (id, convId, role, content, ago, extra = '') =>
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (${sql(id)}, ${sql(convId)}, ${sql(role)}, ${sql(content)}, ${now - ago}${extra ? ', ' + extra.split('=')[1] : ''});`
  const statements = [
    `INSERT OR REPLACE INTO project_workspaces (id, name, color, sort_order, created_at) VALUES ('ws-work', 'Work', '#4f8cff', 0, ${now - 900000});`,
    `INSERT OR REPLACE INTO project_workspaces (id, name, color, sort_order, created_at) VALUES ('ws-personal', 'Personal', '#f0883e', 1, ${now - 800000});`,
    `INSERT OR REPLACE INTO projects (path, name, added_at, sort_order, workspace_id) VALUES (${sql(projectPath)}, 'acme-console', ${now}, 0, 'ws-work');`,
    `INSERT OR REPLACE INTO projects (path, name, added_at, sort_order, workspace_id) VALUES (${sql(sidePath)}, 'notes-cli', ${now}, 1, 'ws-personal');`,
    conv('promo-context', 'claude-code', 'Debug auth callback', 420000, 0, 'sandbox'),
    conv('promo-parallel', 'codex', 'Compare retry strategies', 720000, 80000, 'accept-edits'),
    conv('promo-release', 'opencode', 'Prepare release notes', 900000, 150000, 'plan'),
    conv('side-notes', 'claude-code', 'Add markdown export', 1500000, 600000, 'sandbox', sidePath),
    msg(
      'promo-m1',
      'promo-context',
      'assistant',
      'I found the callback path. The state token is validated after the exchange, which means an expired request still reaches the provider.',
      210000,
    ),
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp, display_body, pills_meta) VALUES ('promo-m2', 'promo-context', 'user', 'Compare src/api/auth.ts lines 1 through 7 with the oauth callback terminal output.', ${now - 150000}, 'Compare [[pill:auth_file]] with [[pill:api_log]].', ${sql(messagePills)});`,
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, tool_calls, timestamp) VALUES ('promo-m3', 'promo-context', 'assistant', 'The exchange should happen only after the state token passes. I would move validation ahead of fetch in \`src/api/auth.ts\` and keep the callback idempotent.', ${tools('Read', { file_path: 'src/api/auth.ts' }, '7 lines')}, ${now - 90000});`,
    msg(
      'promo-m4',
      'promo-context',
      'assistant',
      'Two focused tests cover it: reject an expired state before network I/O, and exchange a valid code exactly once.',
      30000,
    ),
    msg(
      'par-m1',
      'promo-parallel',
      'user',
      'Compare exponential backoff with a fixed 2s retry for the webhook sender.',
      700000,
    ),
    msg(
      'par-m2',
      'promo-parallel',
      'assistant',
      'Exponential backoff with jitter keeps the p95 retry storm under 40 requests per second. A fixed 2s retry peaks at 310.',
      640000,
    ),
    msg('rel-m1', 'promo-release', 'user', 'Draft release notes for 0.8 from the merged PRs.', 880000),
    msg(
      'rel-m2',
      'promo-release',
      'assistant',
      'Three headline changes: remote machines, in-chat diff review, and the kanban board. I will group the rest under fixes.',
      820000,
    ),
    msg('side-m1', 'side-notes', 'user', 'Export a note as markdown with front matter.', 1400000),
    `INSERT OR REPLACE INTO kanban_cards (id, project_path, title, description, tags, status, runtime_mode, worktree_path, worktree_branch, created_at, updated_at) VALUES ('card-1', ${sql(projectPath)}, 'Trace webhook retries', 'Compare backoff strategies without touching the main checkout.', '["backend","reliability"]', 'backlog', 'accept-edits', ${sql(join(projectPath, '.switchboard', 'worktrees', 'webhook-retries'))}, 'kanban/webhook-retries', ${now - 500000}, ${now - 500000});`,
    `INSERT OR REPLACE INTO kanban_cards (id, project_path, title, description, tags, status, runtime_mode, conversation_id, created_at, updated_at) VALUES ('card-2', ${sql(projectPath)}, 'Harden OAuth callback', 'Validate state before exchanging the code.', '["auth","security"]', 'in_progress', 'sandbox', 'promo-context', ${now - 420000}, ${now - 50000});`,
    `INSERT OR REPLACE INTO kanban_cards (id, project_path, title, description, tags, status, runtime_mode, created_at, updated_at) VALUES ('card-3', ${sql(projectPath)}, 'Choose empty-state copy', 'Review the two strongest product directions.', '["design"]', 'needs_input', 'plan', ${now - 300000}, ${now - 70000});`,
    `INSERT OR REPLACE INTO kanban_cards (id, project_path, title, description, tags, status, runtime_mode, completed_at, created_at, updated_at) VALUES ('card-4', ${sql(projectPath)}, 'Add rate-limit telemetry', 'Surface provider reset windows in chat.', '["agents"]', 'done', 'accept-edits', ${now - 60000}, ${now - 600000}, ${now - 60000});`,
    `INSERT OR REPLACE INTO machines (id, name, ssh_alias, ssh_host, ssh_user, ssh_port, transport_kind, sort_order, created_at, updated_at) VALUES ('promo-linux', 'Work machine', 'work', 'work.internal', 'dev', 22, 'ssh', 0, ${now}, ${now});`,
    `INSERT OR REPLACE INTO machines (id, name, ssh_alias, ssh_host, ssh_user, ssh_port, transport_kind, sort_order, created_at, updated_at) VALUES ('promo-build', 'Build server', 'build', 'build.internal', 'deploy', 22, 'ssh', 1, ${now}, ${now});`,
    `INSERT OR REPLACE INTO machine_snapshots (machine_id, data, synced_at) VALUES ('promo-linux', ${sql(snapshotA)}, ${now - 42000});`,
    `INSERT OR REPLACE INTO machine_snapshots (machine_id, data, synced_at) VALUES ('promo-build', ${sql(snapshotB)}, ${now - 95000});`,
    // Diff cards are opt-in and off by default; the 'diff-review' scene needs
    // them expanded to record the accept/reject UI.
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('chat.showFileDiffs', ${sql(String(showFileDiffs))});`,
    // The tour's scenes open chats from the project tree, which is folded by
    // default behind the "This Mac" row.
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('sidebar.localTreeExpanded', ${sql(String(expandLocalTree))});`,
  ]
  // The chat header's linked-PR control reads #612 from the demo pull requests.
  if (linkPullRequest) {
    statements.push(
      `INSERT OR REPLACE INTO conversation_pull_requests (conversation_id, host, owner, repo, number, source, linked_at) VALUES ('promo-context', 'bitbucket', 'geoiq', 'ssg-bot-v2', 612, 'manual', ${now - 100000});`,
    )
  }
  execFileSync('sqlite3', [dbPath, statements.join('\n')])
}

/** The parent and children of the hub screens, by conversation id. */
export const HUB_PARENT = { id: 'hub-parent', title: 'Harden the login flow' }
export const HUB_WORKING_CHILD = { id: 'hub-child-redirect', title: 'Fix callback redirect' }

/**
 * A parent chat with four children in mixed states for the hub screens (flag
 * hub_children): Asked the hub, Result ready and Failed from their stored
 * wakes, and one the suite runs itself, so it shows Working. That child is
 * stored `settled` (a client may send to it then) until `openHubChild` opens it.
 */
export function seedHubChildren(dbPath, projectPath, { now = Date.now() } = {}) {
  const conv = (id, title, ago, extra = {}) =>
    `INSERT OR REPLACE INTO conversations (id, project_path, agent_type, title, created_at, updated_at, runtime_mode, sidebar_role) VALUES (${sql(id)}, ${sql(projectPath)}, ${sql(extra.agent ?? 'claude-code')}, ${sql(title)}, ${now - ago - 60000}, ${now - ago}, 'sandbox', 'managed');`
  const children = [
    { ...HUB_WORKING_CHILD, phase: 'settled', branch: 'hub/fix-callback-redirect', account: 'claude-work', ago: 20000 },
    {
      id: 'hub-child-tests',
      title: 'Write OAuth state tests',
      phase: 'open',
      branch: 'hub/oauth-state-tests',
      account: 'claude-work',
      ago: 140000,
      agent: 'codex',
    },
    {
      id: 'hub-child-retries',
      title: 'Trace webhook retries',
      phase: 'open',
      branch: 'hub/webhook-retries',
      account: 'claude-personal',
      ago: 260000,
    },
    {
      id: 'hub-child-storage',
      title: 'Audit token storage',
      phase: 'failed_start',
      branch: null,
      account: 'claude-work',
      ago: 380000,
    },
  ]
  const wakes = [
    ['hub-child-tests', 'question', 'Should an expired state token return 400 or redirect to the login page?'],
    [
      'hub-child-retries',
      'report',
      'Exponential backoff with jitter keeps retries under 40 per second. Branch pushed.',
    ],
    ['hub-child-storage', 'failed', 'Could not create the worktree: branch hub/token-storage already exists.'],
  ]
  const statements = [
    conv(HUB_PARENT.id, HUB_PARENT.title, 10000),
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp) VALUES ('hub-m1', ${sql(HUB_PARENT.id)}, 'user', 'Split the login hardening into parallel child chats: the redirect fix, state tests, webhook retries and token storage.', ${now - 600000});`,
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp) VALUES ('hub-m2', ${sql(HUB_PARENT.id)}, 'assistant', 'Started four child chats, each on its own branch. I will collect their reports here.', ${now - 590000});`,
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp) VALUES ('hub-m3', ${sql(HUB_WORKING_CHILD.id)}, 'user', 'Brief from the hub: make the OAuth callback redirect back to the page that started the login.', ${now - 580000});`,
    ...children.flatMap((c, i) => [
      conv(c.id, c.title, c.ago, c),
      `INSERT OR REPLACE INTO hub_children (child_id, parent_id, batch_id, ordinal, title, brief, location, branch, provider_instance_id, granted_mode, deps_mode, phase, created_at, updated_at) VALUES (${sql(c.id)}, ${sql(HUB_PARENT.id)}, 'hub-batch-1', ${i}, ${sql(c.title)}, ${sql(`Brief for ${c.title}.`)}, 'worktree', ${sql(c.branch)}, ${sql(c.account)}, 'sandbox', 'link', ${sql(c.phase)}, ${now - 600000 + i}, ${now - c.ago});`,
    ]),
    ...wakes.map(
      ([childId, kind, summary], i) =>
        `INSERT OR REPLACE INTO hub_wakes (id, parent_id, child_id, kind, summary, created_at, delivered_revision) VALUES (${sql(`hub-wake-${i}`)}, ${sql(HUB_PARENT.id)}, ${sql(childId)}, ${sql(kind)}, ${sql(summary)}, ${now - 100000 + i}, 1);`,
    ),
    // Nested children show in the project tree, behind "This Mac".
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('sidebar.localTreeExpanded', 'true');`,
  ]
  execFileSync('sqlite3', [dbPath, statements.join('\n')])
}

/** Moves the working child to `open` once its turn runs (the backend refuses a client's turn to an open child). */
export function openHubChild(dbPath) {
  // The app holds the database open, so wait out a write of its own.
  execFileSync('sqlite3', [
    '-cmd',
    '.timeout 5000',
    dbPath,
    `UPDATE hub_children SET phase = 'open' WHERE child_id = ${sql(HUB_WORKING_CHILD.id)};`,
  ])
}
