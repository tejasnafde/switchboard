# Fork into a worktree contract

This note replaces the original fork-to-worktree kickoff. Worktree forks use
the first-class backend transaction; fork code must not implement a competing
Git orchestration layer.

## Identity

- `projectPath` is the canonical owning parent project used for grouping and
  identity.
- `worktreePath` is the execution checkout used by providers, terminals, the
  IDE, file resolution, and Git operations.
- `worktreeBranch` and `worktreeId` describe the managed checkout.

A worktree path never replaces `conversations.project_path`.

## Git semantics

The backend resolves the canonical repository, source checkout, exact source
HEAD SHA, and tracked/untracked status before side effects. A child fork from
an existing worktree uses that checkout's HEAD but is placed under the stable
canonical repository managed root, never inside the removable source
worktree.

The new checkout starts from the source checkout's committed HEAD. It does not
reconstruct filesystem state from the historical message and does not copy
uncommitted or untracked changes. Dirty sources require confirmation tied to
the frozen HEAD and status digest; a changed source must be confirmed again.

## Recovery

The worktree transaction owns branch/path collision handling, per-repository
serialization, durable receipts, rollback, and cleanup classification. Before
provider or database commit, failures compensate the provider artifact,
worktree, and branch. If commands could have modified the checkout, or cleanup
fails, the backend retains it and returns `cleanup-required` with the exact path
and branch. A dirty worktree is never auto-deleted.

The fork owner transaction commits the managed worktree record, conversation,
rich messages, handoff state, and idempotent result atomically. Retrying the
same `requestId` returns that result.

## UI wording

- Transcript only: “Fork conversation here”.
- New checkout: “Fork conversation into a new worktree from current HEAD”.

All clients show the dirty-source warning and navigate with the returned parent
`projectPath` plus authoritative `worktreePath`.

See `docs/plans/2026-08-24-worktree-creation-transaction-design.md` and
`docs/plans/2026-08-24-conversation-fork-reliability-design.md`.
