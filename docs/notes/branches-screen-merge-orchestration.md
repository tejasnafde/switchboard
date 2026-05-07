# Branches screen — multi-worktree merge orchestration

Status: **design sketch** (not in active queue). Captures the deferred
follow-up to `session-kickoff-fork-to-worktree.md` so the idea doesn't
drift between sessions. Promote to a kickoff doc when we're ready to
build.

Last refreshed: 2026-05-06.

---

## The user's ask, restated

> "I have 4–5 worktrees going in parallel. Some are foundational
> changes that everything else builds on. Others are features that
> assume those foundations. How do I bring them all back to `main` in
> the right order, without losing my mind in conflict resolution?"

This is a **merge-strategy** problem dressed up as a workflow problem.
What the user wants is not "spawn N agents" (Switchboard already does
that via per-card worktrees in `src/main/worktree.ts`) — it's "given N
in-flight branches with implicit dependencies between them, drive them
back to a single trunk with the smallest amount of human-in-the-loop
conflict resolution possible."

We evaluated [conductor-oss/conductor](https://github.com/conductor-oss/conductor)
during 2026-05-06's exploration and ruled it out: it's a JVM workflow
server (Redis/Postgres/ES backends, billions-of-executions scale) for
operators deploying microservice + agent orchestration as
infrastructure. Switchboard is a single-user Electron app. Conductor's
`FORK_JOIN_DYNAMIC` gives you parallel-fan-out + join, but it has
nothing to say about git-aware semantic merging or dependency-ordered
rebases — which is the actual hard part. **Drop it.**

---

## Design shape

### The mental model

Think of the active worktrees as a DAG:

- **Nodes**: worktrees (each on its own branch — see existing
  `kanban/<slug>-<id>` and `fork/<slug>` schemes).
- **Edges**: "B depends on A" means A's diff is a prerequisite for B
  to apply cleanly.
- **Topological sort**: gives a merge order. Branches with no
  dependency between them can be merged in any order (or in parallel,
  but a single trunk merge is sequential by nature — parallelism just
  means "the choice of who-goes-next is free").

The DAG is the central abstraction. Everything else (UI, conflict
handling, dry-run) is in service of building, validating, and
executing that graph.

### The four pieces

1. **Dependency graph (data + small in-process evaluator).**
   200ish lines. Nodes from `listWorktrees(repoPath)` (already
   exists in `src/main/worktree.ts`); edges added by the user (v1)
   or auto-suggested (v2). Toposort + cycle detection. Persist edges
   in SQLite — a `worktree_dependencies` table keyed by
   `(repo_path, parent_branch, child_branch)`.

2. **`mergiraf` for AST-aware conflict resolution.** Shelled out, not
   linked. Check for binary on first use; prompt to install via
   Homebrew (`brew install mergiraf`) if missing. Wire as a custom
   merge driver via `.gitattributes` so `git rebase` invokes it
   automatically on conflict, OR call directly on conflict-marked
   files post-rebase. Driver-style is cleaner; one-time config write
   to `.git/config` per repo.

3. **`git rerere` enabled.** One-shot
   `git config rerere.enabled true` in the repo on first Branches-
   screen open. Memoizes manual conflict resolutions so re-merging
   the same diff (likely if the user iterates on a worktree after a
   partial merge) doesn't re-prompt.

4. **Branches screen (renderer).** Visualizes the DAG; lets the user
   add/remove dependency edges; runs the merge plan. Lives as a new
   **top-level `AppView`** alongside `'chats'` and `'kanban'` — see
   `layout-store.ts:20` (`AppView = 'chats' | 'kanban'`, toggled by
   `⌘⇧K`). Promote the union to `'chats' | 'kanban' | 'branches'`
   and have `⌘⇧K` cycle through all three. Branches is a top-level
   workflow mode (PM view ↔ engineering view ↔ release-orchestration
   view), not a sidecar to chat — the same reasoning that promoted
   the kanban out of the right pane applies here.

---

## Operational flow

```
┌──────────────────────────────────────────────────────────────┐
│ 1. User opens Branches screen for a project                  │
│ 2. Switchboard calls listWorktrees(repoPath) → graph nodes   │
│ 3. User marks edges:                                         │
│    "schema-refactor" is foundation                           │
│    "user-auth" depends on "schema-refactor"                  │
│    "billing-fix" depends on "schema-refactor"                │
│    "ui-polish" stands alone                                  │
│ 4. User clicks "Plan merge"                                  │
│    → toposort produces order: [schema-refactor,              │
│       user-auth | billing-fix (parallel-eligible),           │
│       ui-polish]                                             │
│    → dry-run rebase each branch onto its dependency tip,     │
│       report predicted conflicts (using `git merge-tree`     │
│       --write-tree, which is rebase-without-effect)          │
│ 5. User clicks "Execute"                                     │
│    → for each branch in toposort order:                      │
│       a. git -C <wt> fetch + git rebase <new-base>           │
│       b. on conflict: pause, surface in a side panel         │
│          using mergiraf-resolved markers where it could,     │
│          plain markers where it couldn't                     │
│       c. user resolves; rerere caches the resolution         │
│       d. continue rebase, merge to main as ff-only           │
│    → on completion: branches deleted optionally; worktree    │
│       directories swept on user confirm (existing            │
│       removeWorktree helper)                                 │
└──────────────────────────────────────────────────────────────┘
```

**Dry-run is a hard requirement.** Don't ship execute-without-preview;
the failure mode (a botched rebase across 5 branches) is too painful
to recover from. Use `git merge-tree --write-tree <base> <head>`
(git ≥2.38) to compute the merge result without touching the
working tree — gives us a SHA + conflict file list per pairwise
merge.

---

## Implementation plan (when this gets promoted to a kickoff)

### Files to add

- `src/main/branches/dependencyGraph.ts` — pure module: types
  (`Node`, `Edge`, `Plan`), `toposort`, `detectCycles`,
  `mergePlan(graph): Plan[]`. Heavily unit-tested.
- `src/main/branches/mergePlanner.ts` — wraps git CLI calls:
  `dryRunMerge(repo, base, head)`, `executePlan(plan, callbacks)`.
  Same `GitRunner` injection seam as `worktree.ts` for testability.
- `src/main/branches/mergeDriver.ts` — detects `mergiraf` on PATH,
  installs the merge driver config in `.git/config` once per repo,
  invokes it manually as a fallback when the driver path isn't
  taken (e.g. `git merge-tree` doesn't run drivers).
- `src/main/db/database.ts` — new table `worktree_dependencies`
  `(repo_path TEXT, parent_branch TEXT, child_branch TEXT,
  created_at INTEGER, PRIMARY KEY (repo_path, parent_branch,
  child_branch))`.
- `src/main/provider/provider-registry.ts` — IPC: `branches:list`,
  `branches:add-edge`, `branches:remove-edge`, `branches:plan`,
  `branches:execute`, `branches:resolve-conflict`.
- `src/renderer/components/branches/BranchesScreen.tsx` — DAG
  visualization. `react-flow` or `@xyflow/react` is the obvious
  pick; no other DAG libs in the tree yet. Read-only DAG +
  add-edge interaction.
- `src/renderer/components/branches/MergePlanCard.tsx` — toposort
  result + dry-run conflict preview.
- `src/renderer/components/branches/ConflictResolutionPanel.tsx` —
  side-by-side diff view with mergiraf-resolved hunks pre-applied.
- `src/renderer/stores/layout-store.ts` — extend `AppView` union
  from `'chats' | 'kanban'` to `'chats' | 'kanban' | 'branches'`.
  `toggleAppView` becomes a 3-way cycle (chats → kanban → branches
  → chats). Update the title-bar segmented toggle (currently 2
  segments: Chats / Board) to render 3 segments. `⌘⇧K` keybind
  unchanged — it just cycles further.

### Files to touch

- `src/main/worktree.ts` — already exports `listWorktrees`. We need
  one new helper: `currentBranchOf(repoPath, worktreePath)` (one
  `git rev-parse --abbrev-ref HEAD` invocation).
- `src/shared/ipc-channels.ts` — add the `branches:*` channel
  constants.
- `CLAUDE.md` — document the feature in "What's currently working"
  once it ships.

---

## Auto-detection of dependencies (v2 — out of scope for v1)

For each pair `(A, B)`:

1. Compute `git merge-tree A B` and look for conflict markers in
   the output. If conflicts → A and B touch overlapping regions →
   *suggest* an edge (direction unclear without more signal).
2. Direction heuristic: whichever branch was created earlier (older
   first commit timestamp) is the foundation. Rough but right more
   often than not.
3. Surface in UI as a dashed edge with "suggested" badge; user
   confirms or rejects. Confirmed edges become solid.

Auto-detection is necessary-not-sufficient: two branches can edit
the same file in compatible ways (e.g. both add unrelated functions
to the bottom of `utils.ts`). The heuristic produces false
positives but should rarely produce false negatives — fine for a
suggestion-only flow.

---

## Pitfalls / gotchas

- **Dirty worktrees.** Every worktree in the plan must be clean
  (`git status --porcelain` empty) before execute. Refuse with a
  clear error otherwise. Don't auto-stash — too easy to lose work.
- **Pushed branches.** Rebase rewrites SHAs. If a branch has been
  pushed to a remote (check via `git for-each-ref
  --format="%(upstream)"`), warn loudly before proceeding. Some
  teams hard-prohibit force-push to feature branches; offer a
  "merge commit instead of rebase" mode for them.
- **Submodules.** Same caveat as the kickoff doc:
  `git worktree add` doesn't recursively init submodules, and
  rebases through submodule changes get hairy. Document as known
  limitation; don't try to be clever.
- **Conflict markers + mergiraf interaction.** mergiraf produces
  partial resolutions (resolves what it can, leaves real semantic
  conflicts for the human). The conflict resolution panel needs to
  distinguish "mergiraf resolved this" (show as accepted by default,
  user can override) from "mergiraf gave up here" (raw markers,
  user must resolve).
- **Rebase mid-flight failures.** If the user closes Switchboard
  during an active rebase, the worktree is left in a `REBASE_HEAD`
  state. On next launch, detect this (`.git/rebase-merge/` exists)
  and either resume the plan or offer `git rebase --abort`.
  Persist plan state in SQLite so we can resume.
- **Branch permissions.** A branch may be protected on the remote.
  We don't push as part of this flow — the merge is local-only.
  User pushes manually or via existing tooling. Make this explicit
  in the UI ("merged locally — push when ready").
- **rerere blast radius.** Enabling rerere globally affects every
  conflict resolution in the repo, not just Branches-screen-driven
  ones. That's almost always desirable but mention it in the
  Settings toggle copy.
- **`git merge-tree` version gate.** The `--write-tree` form needs
  git ≥2.38 (Oct 2022). Fall back to a "rebase to a temp branch
  and report conflict files" path if older. Detect once via
  `git --version` at startup; cache the capability.

---

## What unblocks promotion to active

Roughly in priority order:

1. Real user demand — has anyone hit the "5 worktrees, can't merge"
   wall yet, or is this still anticipated? Ship the
   `fork-to-worktree` and kanban-card flows first; let the pain
   accumulate; build this when the request comes from someone
   who's actually got 5 in-flight worktrees and wants out.
2. Decision on rebase-vs-merge-commit default. Probably user-
   configurable per project, but we need a default.
3. mergiraf binary distribution story. Shipping it bundled is
   ideal for UX but cross-platform and license-aware — verify
   licensing (GPL? Apache?) before committing.
4. `react-flow` / `@xyflow/react` dependency adoption — small but
   it's a new graph viz lib in the tree.
5. Schema migration for `worktree_dependencies`. Cheap; any time.

---

## Out of scope (deliberate)

- **Auto-pushing merged branches.** Local-only. User pushes when
  ready.
- **Cross-repo orchestration.** Single repo per Branches screen;
  multi-repo is a different feature entirely.
- **Long-running mergiraf jobs.** mergiraf is fast enough for
  hand-sized diffs; if a worktree has 10k changed files, the user
  has bigger problems.
- **Workflow execution engine** à la Conductor. We do not need
  durable workflow primitives, distributed task queues, replay-
  ability across machines, or anything resembling that — this is
  a single-user, single-repo, in-process operation. The "DAG" here
  is hand-constructed state in a sqlite table; the "executor" is a
  for-loop with sub-step persistence so we can resume after a
  crash mid-rebase. Anything more is yak-shaving.

---

## References

- `src/main/worktree.ts` — existing primitives we extend, not
  replace.
- `docs/notes/session-kickoff-fork-to-worktree.md` — sibling
  feature; this doc was promised in its "Out of scope" section.
- `docs/notes/roadmap-deferred.md` — register this feature there
  as a one-paragraph entry pointing back here, when promoted.
- mergiraf: <https://mergiraf.org/> — AST-aware structural merge
  tool.
- git rerere: <https://git-scm.com/book/en/v2/Git-Tools-Rerere> —
  reuse-recorded-resolution.
- conductor-oss/conductor: evaluated 2026-05-06 and ruled out;
  wrong scale, wrong shape. The `FORK_JOIN_DYNAMIC` operator's
  *idea* (declarative dynamic fan-out + join) is a useful mental
  model but the implementation is server-grade infrastructure.
