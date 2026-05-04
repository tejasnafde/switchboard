# Session kickoff — `fork-to-worktree` (#5)

Drop this doc into a fresh Claude session as the first turn. It's
self-contained: nothing here assumes prior conversation context.

**Prerequisite**: `fork-from-message` (#4) ships first. This task
extends that feature — read `session-kickoff-fork-from-message.md`
alongside this doc; that one owns the conversation cloning and
adapter-aware resume; this one owns the git worktree side.

---

## What we're building

When forking a conversation, optionally also branch the working tree:

1. Create a new git branch off `HEAD` (or off the parent
   conversation's branch if it's already on a feature branch).
2. `git worktree add` it to a path inside `<repo>/.switchboard/worktrees/`
   (or wherever feels right — see "Worktree storage" below).
3. The forked conversation's `projectPath` points to the worktree, not
   the original repo. So when the user resumes work in the fork, the
   agent's cwd is the new working tree, terminal panes default to it,
   the file pane reads from it.
4. The branch name is auto-generated from a cheap-model summary of the
   forked-from message (e.g. "fix-redis-timeout").

Why: lets the user explore "what if I tried a different approach to
this turn" without a manual `git stash` / `git checkout -b` /
`cd ../newdir` dance. Agent works on real files, committable, mergable
back later.

---

## Repo orientation (Switchboard)

Read `CLAUDE.md` at repo root. Key surfaces:

- **Existing kanban worktree fields**: the `kanban_cards` table
  already carries `worktreePath` and `worktreeBranch` columns — see
  `src/main/db/database.ts` (search for `kanban_cards`). Worktree
  creation logic for kanban cards already exists somewhere in
  `src/main/` — find it via `git worktree add` grep. Reuse / share
  helpers; do not duplicate.
- **Project path scoping**: `projectPath` lives on `conversations`
  rows AND on `AgentSession` in
  `src/renderer/stores/agent-store.ts:24-69`. The terminal store
  defaults pane cwd to the active session's `projectPath` — so once
  the fork's projectPath is the worktree, terminals + file pane "just
  work" without further wiring.
- **`assertCwdReadable`** in `src/main/path-access.ts` runs as
  pre-flight on `START_SESSION`. Make sure newly-created worktrees
  pass it (they should — same physical disk as the parent repo).
- **Cheap-model summary**: There's no existing helper for "run a
  one-shot turn for a title". Cheapest path: spawn a quick Claude
  Code SDK query with `maxTurns=1` (we already do this for
  auto-titles in `src/shared/auto-title.ts` — read it; you can
  factor a `summarizeForBranchName` next to `generateTitle`).
- **Provider registry**: `src/main/provider/provider-registry.ts`
  is where you'd add the IPC `conversations.forkWithWorktree` (or
  add a `withWorktree: boolean` flag to the existing fork IPC from
  #4 — preferred, less surface area).

---

## Implementation plan

### 1. Branch slug helper

Pure function in `src/shared/branchSlug.ts`:

```ts
export function makeBranchSlug(summary: string): string
```

Lower-case, replace whitespace + non-alphanumerics with `-`, collapse
runs of `-`, trim, cap length at ~40 chars, prefix with `fork/`.
Example: "Fix Redis timeout in worker pool" → `fork/fix-redis-timeout-in-worker-pool`.

Worth unit-testing — input/output table is straightforward.

### 2. Cheap-model summary

Function `summarizeForBranchName(messageBody: string,
projectPath: string): Promise<string>`. Uses the same Claude SDK
single-turn pattern as `generateTitle`. Prompt:

> Summarize the following message in 4-8 words suitable for a git
> branch name. No punctuation, no leading verbs.

If the SDK call fails, fall back to a deterministic slug from the
first 40 chars. **Do not block the fork on this** — generate the
branch name optimistically, kick off the rename in the background if
the LLM call returns something better. Worktrees can be renamed via
`git branch -m <new>` without touching the working tree.

### 3. Worktree storage

Decide between:

- **Inside the repo** at `<repo>/.switchboard/worktrees/<slug>/` —
  needs a `.gitignore` entry. Simple, discoverable, doesn't sprawl.
  **Recommended**.
- Sibling directory at `<repo>/../switchboard-worktrees/<slug>/` —
  cleaner separation but more code to compute paths and explain to
  users.

Pick one and stick with it. Whatever you pick, make it configurable
in settings later but ship a sensible default first.

Add `.switchboard/` to `.gitignore` (only if option 1) — but only
if the user's repo doesn't already ignore it. Read existing
`.gitignore` first; append if missing; warn-don't-error if the file
is locked.

### 4. Worktree creation

Helper `createForkWorktree(opts: { repoRoot: string; baseBranch: string;
newBranch: string }): Promise<{ worktreePath: string; branch: string }>`:

```sh
git -C <repoRoot> worktree add -b <newBranch> <worktreePath> <baseBranch>
```

Capture stderr verbatim; surface it on failure. Things that go wrong:

- Branch name collides with an existing branch (suffix `-2`, `-3`,
  etc., up to a small N before failing).
- Working tree at the target path already exists (same suffix logic).
- Repo is shallow / has no commits (rare; user error — bail with a
  clear message).

### 5. Wire into `conversations.fork` (from #4)

Extend the IPC payload:

```ts
fork(args: {
  sourceConversationId: string
  upToMessageId: string
  withWorktree?: boolean   // NEW
}): Promise<{ conversation: Conversation; resumeHint: string | null }>
```

When `withWorktree` is true:

1. Determine `baseBranch` from the source conversation's `projectPath`
   (`git -C <path> rev-parse --abbrev-ref HEAD`). If detached HEAD,
   use the SHA and create the new branch off that.
2. Generate slug from the picked message body via
   `summarizeForBranchName`.
3. `createForkWorktree(...)`.
4. Override the new conversation's `project_path` with the worktree
   path before INSERT.
5. Persist `worktree_path` + `worktree_branch` on the new conversation
   row (add columns if not already there from #4 — the kanban table
   already has them so the pattern's clear).

### 6. UI: option in the fork menu

The right-click menu from #4 shipped with one entry ("Fork from
here"). Add a second: **"Fork to worktree"**. Same flow but passes
`withWorktree: true`. Show the chosen branch name in a tiny toast
after creation: "Forked to fork/<slug>".

### 7. Tests

- `makeBranchSlug` table tests.
- `createForkWorktree` is integration — gate it behind a `git`-
  available check and skip in CI if needed. Use a tmp git repo
  fixture.
- DB: assert the forked conversation row has both `worktree_path`
  and `worktree_branch` populated.
- Resume verification: same as #4 but cwd should now be the worktree
  path, not the original repo (terminal pane spawns there, file
  pane lists from there).

---

## Pitfalls / gotchas

- **`git worktree add` locks**: Two forks racing on the same repo
  can collide on `.git/worktrees/`. Serialize per-repo with a small
  in-process mutex keyed by `repoRoot`.
- **Submodules**: `git worktree add` doesn't recursively init
  submodules. If the user's repo has them, doc it as a known
  limitation; don't try to be clever.
- **Untracked files**: aren't carried into the new worktree. That's
  the standard `git worktree` behaviour and probably what users
  expect, but call it out in any docs we write for this feature.
- **Path display in sidebar**: forked conversation's display path
  becomes ugly (e.g. `…/myrepo/.switchboard/worktrees/fork-fix-x/`).
  Consider showing `<repo> · fork/fix-x` instead — the worktree
  branch name is the human-meaningful part. Sidebar lives at
  `src/renderer/components/sidebar/Sidebar.tsx`.
- **Cleanup**: when a forked conversation is **archived** (existing
  archive system — see CLAUDE.md "Archive system"), don't auto-delete
  the worktree. The user may have committed work there. Show a
  separate "Delete worktree" action in the conversation context menu
  that does `git worktree remove` and `git branch -D` after a
  confirm dialog. Out of scope for v1 if you're tight on time —
  document as a follow-up.
- **`thread_sessions`**: completely unrelated; ignore.
- **Worktree on Windows**: use `path.join` everywhere; never hardcode
  forward slashes. Switchboard supports Windows builds (electron-
  builder targets `win`), so worktree path construction must respect
  the platform separator.

---

## Definition of done

- `makeBranchSlug` ships with tests.
- `summarizeForBranchName` works end-to-end against Claude Code SDK
  with a deterministic fallback.
- `createForkWorktree` works with collision handling.
- `conversations.fork` accepts `withWorktree: true`.
- "Fork to worktree" entry in the message context menu.
- Forked conversation opens with cwd = new worktree path; terminal
  pane and file pane read from there.
- DB schema persists `worktree_path` + `worktree_branch` on the
  forked conversation row.
- Sidebar shows a friendly label (`<repo> · <branch>`) for worktree-
  backed conversations.
- `npm run typecheck && npm test` clean.
- One CHANGELOG.md line.

---

## Out of scope (deliberate)

- Auto-merge of fork branches back to base (the user's existing ask
  for "how do I merge 4-5 worktrees?" is a separate, larger feature
  involving rerere + mergiraf + a top-level Branches screen).
- "Delete worktree" UI (mentioned above as cleanup follow-up).
- Cross-platform smoke (test on macOS first; Windows is a follow-up
  unless trivial).
- Per-fork environment overrides (different `.env`, different agent
  config). Worktree shares parent's tooling; that's fine for v1.
