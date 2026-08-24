# Switchboard Domain Context

## Worktree lifecycle

- **WorktreeCreation**: A durable, recoverable operation that materializes and provisions one managed Git worktree. Its identity is `creationId`; progress events are observations of this record, not the record itself.
- **WorktreeRecord**: The canonical durable identity and lifecycle record for one Switchboard-managed worktree. A filesystem path is an attribute of this record, not its identity.
- **creationId**: A client-generated, machine-scoped idempotency key and progress-correlation identity. Reusing it with a changed request is a conflict.
- **owner**: The product entity for which a worktree is created, such as a conversation, Kanban card, or forked conversation. A worktree can subsequently be referenced by additional compatible projections.
- **purpose**: The product reason for creation: new chat, Kanban work, or conversation fork.
- **provenance**: The requesting surface, bound machine, request time, and compatibility generation. Provenance never contains credentials or secret environment values.
- **lineage**: Product ancestry between conversations, messages, and managed worktrees. It is independent from Git ancestry.
- **baseRef**: The Git ref or commit from which a worktree is populated. It is not a lineage parent.
- **parentWorktreeId**: An optional WorktreeRecord identity representing product lineage. It does not select the Git base ref.
- **setupPolicy**: Whether the checked-in repository setup hook is inherited, explicitly run, or skipped.
- **setupReceipt**: The durable resolution and outcome of setup, including configuration source, resolved policy, command fingerprint, timing, and result.
- **startupReceipt**: The durable handles and outcomes for launch-config terminals, startup commands, provider startup, and initial prompt delivery.
- **projectPath**: The stable owning repository/root used for project grouping, identity, and repository configuration.
- **worktreePath**: The execution CWD of a worktree-backed conversation or workspace.

## Delivery and recovery

- **definite rejection**: A failure proven to have happened before the relevant external boundary. Safe compensation or retry is possible.
- **ambiguous execution**: A failure where an external command, provider, or transport might have accepted work. It must be reconciled using durable identities and receipts rather than blindly repeated.
- **cleanup required**: A recoverable terminal creation state where the worktree is retained because setup or startup may have modified it, or safe compensation could not be proven.
- **compatibility projection**: A legacy path/branch field retained on a conversation or Kanban card for mixed-version clients. It mirrors canonical ownership but is not the source of truth.
