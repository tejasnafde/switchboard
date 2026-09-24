# Execution-root relocation

Status: in progress. Foundation landed; the backend transaction, drift
revisioning, terminal reconciliation and the mobile clients are outstanding.

Written 2026-09-17 against `v0.8.58`. Filed under the date the work was
specified so it sits beside the sibling worktree designs.

## The bug

"Follow" does not move anything. `swapWorktreePointer` in `ChatInput.tsx`
calls `setWorktree` on the store and persists `worktree_path` through
`SET_CONVERSATION_WORKTREE`. The live provider keeps running in the directory
it was spawned in.

`ProviderRegistry.updateSessionCwd` only updates the registry's own
`sessionCwd` map, the drift baseline and the notebook mirror root. It never
touches `ProviderSession.cwd`, and it never reaches the adapter. No adapter
exposes a way to change its working directory without a restart. So after a
Follow:

1. The branch chip and the database say the worktree. The process says the
   parent checkout.
2. The next tool call runs in the old directory.
3. The drift watcher sees a write outside the new home and offers to Follow
   again. Per-turn re-arm means it offers forever.
4. New terminals opened afterwards still started in the parent checkout,
   because five creation entry points read `projectPath` directly.

## The shape of the fix

Relocation is a TRANSACTION owned by the backend that owns the path, not a
renderer state update. The commit boundary is a successful provider start at
the target. Before that boundary nothing durable changes; after it, the
provider, the registry, the database row, the drift baseline, the IDE, the
notebook mirrors and the terminal defaults all move together.

### 1. Domain model (landed)

`src/shared/execution-root.ts`.

`ExecutionRoot` carries four things beyond the path:

- `projectPath`, the parent identity, which never moves. The sidebar, the DB
  and the favicon cache group by it.
- `machineId`. An absolute path means nothing without the backend that owns
  it. Comparing `/repo/app` on this Mac with `/repo/app` on a VM as if they
  were the same directory is how a local `cd` gets sent for a remote move.
- `branch`, resolved from git rather than trusted from the renderer.
- `revision`, a monotonic integer. This is the part that is easy to skip and
  expensive to omit. A relocation is asynchronous at three points: drift
  evidence is gathered in a fire-and-forget hook, a queued relocation waits
  for a turn to end, and a provider restart takes seconds. Any of those can
  land after the root already changed. Without a revision the late result
  looks indistinguishable from a fresh one and commits against a superseded
  root.

The module deliberately does not use `node:path`. It reasons about a remote
machine's paths, and `path.sep` describes the host it is running on, which is
the wrong machine. `isPathWithinRoot` is separator-aware so `/repo/app-old` is
not read as living inside `/repo/app`; plain `startsWith` would re-root a
terminal sitting in an unrelated sibling checkout.

### 2. The relocation contract (landed)

`src/shared/execution-root-relocation.ts`.

A request carries the thread, the expected revision, the target path and
branch, the owning machine, and a reason (`drift-follow`, `branch-picker`,
`orphan-heal`, `manual`). The result is structured, not `{ ok: true }`:
`relocated`, `already-at-target` and `queued` on success; `busy`,
`stale-revision`, `wrong-machine`, `invalid-target`, `target-missing`,
`different-repository`, `continuity-unsupported`, `unknown-thread`,
`target-start-failed` and `rollback-failed` on failure, with `rolledBack` so
a caller can tell "nothing happened" from "we could not put it back".

`classifyRelocationPreconditions` is pure. Its ordering is the design, not an
accident:

1. Target validity and the revision first, so a malformed or stale request is
   refused identically whether or not a turn is running.
2. Contention next. A profile switch and a relocation share the same snapshot
   and event-gate machinery, so they must not interleave.
3. The turn check LAST among blocking checks, and its answer is `queue`, not
   a failure. A drift suggestion almost always arrives DURING a turn. Killing
   that turn because the user clicked a button is worse than waiting a few
   seconds for it to end.

An expected revision from the future is rejected as firmly as one from the
past: it means the caller is reasoning about a state this backend never
published.

### 3. Terminal defaults (landed)

`src/renderer/services/execution-root.ts` is the single lookup. All seven
creation entry points now use it: `TerminalStrip`, `TerminalWindow`, three
`CommandPalette` commands, two `App.tsx` keyboard shortcuts, and both
`useTerminalLifecycle` hydration paths.

`tests/unit/terminal-cwd-execution-root.test.ts` guards the SHAPE of the call
sites rather than the behaviour of five known ones, because the defect class
is "a new entry point forgot", and a behaviour test of today's five cannot
catch tomorrow's sixth.

## Outstanding

### 4. The backend transaction

`ExecutionRootCoordinator`, reusing the machinery that already exists for
provider-instance switching in `provider-registry.ts`:

- `switchingSessions`, the per-thread claim, extended to cover relocation so
  the two operations exclude each other.
- `ProviderEventGate`, the `staging`/`flushing`/`committed`/`discarded`
  buffer, so events from the target session are held until the root commits
  and are discarded if it does not.
- `sessionEpochs`, which fences an adapter's `onEvent` by provider-process
  execution rather than by thread id. A stopped source and its replacement
  share a thread id, so without the epoch the dying process can still emit.
- The snapshot and rollback pattern: capture the descriptor and the resolved
  credentials AFTER `stopSession` resolves, restart the source on failure.

Validation before any mutation, on the owning machine: realpath both ends,
compare normalized `git rev-parse --git-common-dir` (the existing
`ExecFileGitWorktreeAdapter.resolveRepository` already returns exactly this),
and resolve the real branch from git rather than trusting the renderer label.

Commit order, in one database transaction: adapter session, registry
descriptor and `sessionCwd`, revision increment, `worktree_path` and
`worktree_branch`, then re-root checkpoints, notebooks, git watchers and IDE
routing, then publish `session.execution-root-changed` carrying the old root,
the new root, the branch, the revision, the reason and the continuity result.

Note a latent bug to fix on the way: `setConversationWorktree` does not
resolve through `resolveRootThreadId`, so a caller holding Claude's rotated
session UUID writes to nothing. This is the trap CLAUDE.md records having hit
twice already.

### 5. Provider continuity

- Claude. `claudeSessionResumePath(dir, sessionId, cwd)` already encodes the
  cwd into the resume path, and `ensureClaudeSessionResumable` already runs
  at every query start. Relocation is therefore: stop, copy the freshest
  transcript to the target cwd's resume location, restart with
  `resumeSessionId`. Native session UUID preserved, no synthetic handoff.
- Codex. `turn/start` already sends `active.session.cwd` on every turn, and
  `thread/resume` takes a cwd. The thread id survives a restart, so this is
  cheap.
- OpenCode. The ACP adapter never captures `agentCapabilities` from
  `initialize`, and never calls `session/load`. The registry already refuses
  to profile-switch OpenCode for the same reason. Until `loadSession` is
  captured and used, relocation must return `continuity-unsupported` and
  offer a deliberate restart, never a silent cold start.

### 6. Drift hardening

Capture `(machineId, rootPath, revision)` before the asynchronous check in
`driftHook`, and re-check it before publishing. `onSessionMoved` currently
clears `notified` and `homeCache` but NOT `pending`, so command evidence
gathered before a move is still flushed against the new home; pending must be
cleared per superseded revision.

Command classification gets explicit confidence. Today a bare absolute path
anywhere in a shell command counts as evidence, so merely reading or diffing
a file in another worktree implies the provider moved. High confidence:
`EnterWorktree`, a structured `cwd`, a confirmed write destination. Lower:
`cd`, `git -C`, redirection. Ignored: read-only path arguments.

### 7. Existing terminals

Managed zsh only in this release; bash, fish, PowerShell, cmd and tmux report
`unsupported-shell` and are left alone. `resources/shell/switchboard.zshrc`
has no `precmd`/`preexec` today and emits no OSC, so shell integration has to
be added: verified cwd, prompt boundaries, whether the input buffer is dirty,
and a root-revision acknowledgement. `pty-manager.ts` parses no output today
beyond a plain `waitFor` substring match, so marker parsing is new.

A pane moves only when it is on the affected session and machine, is a
managed interactive zsh, has reported a clean idle prompt, has no unsubmitted
input, has no foreground job, and sits inside the old root. Anything running
`ssh` or `mosh` is never written to: a local `cd` sent into a remote login is
typed into somebody else's shell.

### 8. Clients

Desktop currently drops every drift event whose `machineId` is not `local`,
because the renderer cannot safely write a remote path into local routing.
The backend-authoritative transaction removes that reason: the renderer sends
a request to the owning machine and never interprets the path itself.

Mobile ignores `worktree.drift` entirely (no case in its reducer). Android
renders it as a passive `NoticeCard` with no action. Both need the Follow
action against the shared contract, and both must ignore a stale revision.

## Compatibility

`execution_root_revision` is a new nullable integer column on `conversations`
with an idempotent `PRAGMA table_info` guard, matching every other migration
in `database.ts`. Absent means 0. An older client that never sends an
expected revision is refused only if it tries to relocate a thread that has
moved, which is the correct outcome. No package identity, deep-link, signing
or update-channel change.
