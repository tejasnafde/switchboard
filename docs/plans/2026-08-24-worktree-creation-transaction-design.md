# Worktree Creation as a First-Class Transaction

**Date:** 2026-08-24
**Status:** Implemented
**Target:** v0.8.43

## Objective

Make every Switchboard-managed worktree originate from one backend-owned, recoverable creation transaction. A renderer or mobile client submits intent and observes a durable operation; it never coordinates Git, SQLite ownership, setup, terminal startup, provider startup, the initial prompt, or rollback.

The implementation is an explicit saga because SQLite, Git, filesystem artifacts, terminals, and provider subprocesses cannot participate in one ACID transaction.

## Verified current state

The investigation confirmed the reported problems:

- `src/main/worktree.ts` has independent Kanban, fork, and new-session helpers with different roots and naming rules.
- Desktop creates routing and renderer state before best-effort conversation persistence, and silently falls back to the parent checkout after an explicit worktree request fails.
- Kanban commits the card and Git worktree in separate directions, leaving either partial cards or orphaned worktrees.
- Forking materializes Git before transcript and database work, without compensation.
- Fork rows and renderer hydration conflate `projectPath` and `worktreePath`.
- Stale detection treats only Kanban paths as in use. The Worktree Manager can consequently present live conversation/fork worktrees, and arbitrary user-created linked worktrees, as removable.
- Conversations and cards have path/branch projections but there is no canonical worktree identity or operation journal.
- Launch config has terminal `on_start` behavior but no setup hook, and its parser would discard an unknown top-level worktree section.
- React Native and Android create a conversation, start a provider, and enqueue the first turn as separate calls; neither exposes worktree creation or correlated recovery.

The audit also found that Kanban-launched conversations fail to persist their worktree projection, raw `startsWith` containment checks accept sibling prefixes, and fork creation from an existing worktree can derive the wrong managed root. These are part of this change because they violate the same ownership and cleanup invariants.

## Considered designs

### Patch each caller

Adding compensation and retries independently to Desktop, Kanban, and fork paths would be a small initial diff. It was rejected because it retains multiple coordinators and cannot provide one restart recovery model, cleanup authority, or mobile contract.

### Add only a creation journal

A journal beside existing nullable path strings could resolve some ambiguous retries. It was rejected because paths would remain identities, ownership sharing would remain implicit, and cleanup could still confuse live and orphaned worktrees.

### Canonical catalog plus creation saga

This is the selected design. A deep main-process module owns validation, materialization, ownership, provisioning, recovery, and cleanup eligibility. Clients see only a typed intent, authoritative snapshots, and recovery actions.

## Public contract

The shared API has three entry points:

```ts
interface WorktreeCreationApi {
  createWorktreeTransaction(
    request: WorktreeCreationRequest,
  ): Promise<WorktreeCreationSnapshot>

  getWorktreeCreation(
    request: GetWorktreeCreationRequest,
  ): Promise<WorktreeCreationSnapshot | null>

  actOnWorktreeCreation(
    request: WorktreeCreationActionRequest,
  ): Promise<WorktreeCreationSnapshot>
}
```

`actOnWorktreeCreation` is revision-checked and supports only explicitly modelled backend actions: choose setup, retry a safe phase, cancel before an ambiguous external boundary, retain, or remove a verified managed worktree. Starting in the parent checkout is deliberately client-owned: it creates a fresh parent-checkout conversation only after the failed snapshot explicitly advertises that choice. It is never sent as an action against the failed worktree operation. Cancellation that cannot be proven safe returns a recovery disposition instead of deleting.

The versioned request is nested around these concepts:

```ts
type WorktreeCreationRequest = {
  schemaVersion: 1
  creationId: string
  repository: { projectPath: string; machineId: string }
  checkout: {
    baseRef: string
    branch: { namespace: 'sb' | 'fork' | 'kanban'; seed: string }
    location?: 'managed-in-repo' | 'managed-user-data'
    sparseCheckout?: {
      mode: 'cone'
      directories: string[]
      presetId?: string
    }
  }
  owner:
    | ConversationCreationOwner
    | KanbanCreationOwner
    | ForkCreationOwner
  purpose: 'new-chat' | 'kanban' | 'fork'
  setup: { policy: 'inherit' | 'run' | 'skip' }
  launch?: WorkspaceLaunchIntent
  lineage?: WorktreeLineage
  provenance: WorktreeCreationProvenance
}
```

Owner variants carry the information needed to commit their owner atomically. A new Kanban card therefore carries its draft fields; an existing card carries its stable ID and expected revision; a fork carries source conversation, boundary, and provider-specific resume inputs. Callers do not perform a preliminary owner write.

Provenance supplied on the wire is descriptive and is not an authentication claim. Filesystem mutation runs only on the backend that received the routed request; authenticated transport scope, not provenance, decides whether setup, terminal resources, or destructive cleanup are authorized. Chat-only clients cannot remove a worktree. The stable machine selected by the client remains part of the creation key so reconnecting clients query the same backend operation.

Snapshots return the full authoritative state: creation identity and revision, phase/status, canonical worktree identity, project/worktree paths, branch/base ref, owner, lineage, provenance, sparse receipt, setup receipt, startup receipt and stable resource handles, warnings, error, and recovery actions.

## Durable model

A migration adds two source-of-truth tables.

### `managed_worktrees`

Stores immutable worktree ID, machine and canonical repository identity, stable project path, worktree path, branch, base ref and resolved commit, management origin, lifecycle state, initial owner/purpose, provenance, lineage, sparse/setup/startup receipts, creation/update timestamps, and error/recovery data.

### `worktree_creations`

Stores machine-scoped `creationId`, schema version, canonical request JSON and payload hash, current phase/status/revision, reserved path and branch, worktree ID, external-boundary markers, receipts, warnings, error/recovery data, and timestamps. A unique `(machine_id, creation_id)` key enforces idempotency. Same key and hash resumes; same key and changed hash is a hard conflict.

Conversations and Kanban cards gain nullable `worktree_id` and creation linkage. Their existing `worktree_path` and `worktree_branch` remain dual-written compatibility projections. Multiple conversations/cards can therefore reference one canonical worktree without introducing a path-based identity or a separate public ownership service.

Canonical worktree records do not cascade when a project or owner is removed. Losing the last projection makes a managed record eligible for explicit cleanup; it does not erase cleanup evidence.

## State machine and commit boundaries

```text
pending
  -> materializing
  -> configuring
  -> linking
  -> awaiting_setup_decision (when repository default is ask)
  -> provisioning
  -> ready
```

Terminal/recovery states are `failed`, `rolled_back`, `cleanup_required`, and `cancelled`.

1. Parse and validate the complete request, including routing, repository identity, Git refs, branch seed, locations, sparse paths, owner preconditions, and capability/security policy.
2. Persist `pending` and the exact payload hash before Git mutation.
3. Acquire a mutex keyed by canonical repository identity for Git mutation, sparse configuration, and durable owner linkage. Different repositories continue concurrently, and the mutex is released before potentially long setup/startup work. Restart recovery begins in the background so querying or acting on another creation is not held behind a long setup command; the same creation is reconciled through one in-flight recovery.
4. Reserve a deterministic path and branch for the creation, then materialize with argument-array Git operations. Recovery distinguishes absent, branch-only, worktree-only, exact, and conflicting materialization rather than treating a partial Git result as a completed checkout.
5. Apply cone-mode sparse checkout before setup, startup commands, terminals, providers, or prompts.
6. In one SQLite transaction, persist the canonical worktree record, owner data/lineage, and all compatibility projections.
7. Resolve setup policy. An inherited `ask` default pauses with an explicit recovery action rather than guessing.
8. Provision setup, launch-config terminals, startup commands, provider session, and initial prompt in the configured order.
9. Mark `ready` only when all requested resources have authoritative receipts.

Before external commands begin, a definite failure with no durable owner removes the exact registered worktree and created branch and compensates staged fork artifacts. Compensation may remove only resources created by the operation; an explicit user-approved cleanup may additionally remove a verified clean linked worktree whose branch advanced after ownership committed. Once setup, startup, terminal commands, or provider execution might have modified the tree, automatic destructive rollback is forbidden. The operation becomes recoverable and the worktree remains catalogued.

For `start-immediately`, setup and workspace startup may overlap only after durable ownership. Their independent receipts record the outcome. For `wait-for-setup`, no terminal, provider, or initial prompt starts until setup succeeds or is explicitly skipped.

## Git and sparse checkout

- Resolve the canonical repository/common Git directory even when the supplied project is already a linked worktree.
- Serialize mutations per canonical repository, not globally.
- Derive managed paths inside the selected in-repository or user-data root. Use `relative()`-based containment checks after canonicalization.
- Validate base refs and branch seeds before mutation. Human-readable names include a stable creation suffix; collision reconciliation never adopts an unrelated branch/path.
- Invoke Git through argument arrays/`execFile`; never interpolate Git arguments into a shell.
- Sparse checkout supports cone mode only. Reject absolute paths, empty entries, `.`/`..` traversal, and paths escaping the repository. Preserve `presetId` as provenance and record normalized directories.

## Setup and startup

Launch config gains an additive repository-level section separate from terminal `on_start`:

```yaml
worktree:
  setup:
    command: npm install
    default_policy: ask # ask | run | skip
    startup_policy: wait-for-setup # wait-for-setup | start-immediately
```

No package-manager command is inferred. `run` with no configured hook records `not_configured`. An `ask` receipt binds approval to a fingerprint of the resolved command; if checked-in configuration changes before approval, the backend returns a fresh decision instead of running a newly substituted command. The parser, serializer, editor, validation, and documentation preserve the new fields.

User-authored setup/startup commands are intentional shell inputs, but they execute only on the bound owning machine through the high-level backend contract. Mobile chat scope cannot be used as an arbitrary shell bypass: chat-only clients may start the selected provider and initial prompt, but the backend persists `terminalPolicy: skip`, refuses setup execution, and creates no PTY or launch-config `on_start` command. Setup, terminal layouts, and ad hoc startup commands require terminal scope. Command-bearing launch-config files are also protected from chat-only direct writes. Receipts and logs omit environment secrets and store only safe command source/fingerprint information.

Terminal layouts are provisioned by an idempotent backend runtime using stable handles. The renderer adopts those handles rather than creating fallback PTYs. Configuration source and execution root are distinct: `projectPath` identifies repository configuration and grouping; `worktreePath` is terminal, IDE, provider, and command CWD.

Provider startup occurs only after durable identity/ownership. The initial prompt uses the atomic user-turn contract with a stable origin derived from `creationId`; retry/reconnect reconciles that exact envelope and cannot dispatch it twice. Provider-start rejection is definite. A thrown prompt submission after provider startup is ambiguous and retains the stable thread/origin for same-envelope reconciliation.

Setup commands have a bounded runtime and cancellation signal. The default host timeout is thirty minutes and can be configured by the embedding runtime. A timeout is recorded as ambiguous because the process may have modified the checkout; it never triggers automatic deletion.

## Owner behavior

### Desktop new chat

The user explicitly selects the parent checkout or a new worktree. A worktree request does not enter Zustand/sidebar as ready before the authoritative result. Failure offers Retry, Start in project, and applicable recovery actions. Start in project creates a separate explicit request; it is never a catch fallback.

### Kanban

New-card fields are part of the owner intent. A failed worktree request deliberately preserves a visible backlog card linked to the failed creation so its description and intent remain editable, including when the failed reservation has no canonical `worktree_id` yet. It shows the applicable recovery actions and never auto-launches accidentally. Successful card creation/linkage and optional conversation/provider/prompt provisioning are receipts from the same transaction; an agent-backed launch advances the card to `in_progress`, while a no-agent creation preserves the requested status. A card that already has a live conversation refuses a later attach request rather than replacing that conversation or sending the card prompt twice; the existing conversation remains reusable.

### Fork

Transcript assembly/copy, lineage, worktree creation, and owner persistence are one coordinated saga. Provider-specific degraded resume remains unchanged. Before provisioning, a transcript or database failure compensates the worktree and staged artifacts. The fork retains its parent `projectPath`, uses `worktreePath` as CWD, and returns both authoritatively.

## Progress and reconnect

`worktree.creation.progress` contains `creationId`, revision, phase/status, timestamp, concise detail, and available recovery actions. It uses phases rather than fake percentages. Events are replayable, but clients always query the durable snapshot after reconnect or process restoration.

React Native persists the creation identity and editable intent until an authoritative terminal result. Definite contract/authentication rejection does not enter a reconnect loop, while transport uncertainty queries the same creation. Android stores equivalent pending launch state in Room so process death resumes by querying the same `creationId`, never by minting a replacement; a retryable rolled-back journal remains durable until an explicit terminal disposition.

Desktop retains cleanup-required conversations in the session inventory as recovery entries rather than presenting them as ordinary ready chats. Selecting one opens its authoritative recovery snapshot. Terminal, cancelled, removed, and actionless rolled-back journals are dismissed; retained resources remain discoverable.

## Recovery matrix

| Persisted phase | Restart/retry action |
| --- | --- |
| `pending` | Resume validation/materialization or cancel safely. |
| `materializing` | Inspect exact path/branch/commit identity, including a branch-only partial add. Resume or complete an exact creation; compensate an absent/definitely failed one; quarantine a mismatch. An unknown live state is reconciled immediately rather than parked indefinitely. |
| `configuring` | Verify sparse state and resume, or compensate because no external command has run. |
| `linking` | Resume if the atomic owner commit exists; otherwise remove the unowned exact worktree and staged artifacts. |
| `awaiting_setup_decision` | Return the durable choice prompt; do not mutate further. |
| `provisioning` | Reconcile stable resource handles and atomic prompt origin. Never blindly rerun an ambiguously interrupted setup/startup command. |
| `ready` | Return the canonical result without repeating any resource creation. |
| `failed` / `rolled_back` / `cancelled` | Return the recorded disposition; retry only through an allowed revision-checked action. |
| `cleanup_required` | Retain by default and expose verified retry, retain, or removal actions. |

## Cleanup model

The canonical catalog plus all compatibility projections and nonterminal reserved paths is the cleanup authority. Raw `git worktree list` entries are inventory, not proof of ownership. A managed worktree is removable only when its immutable stored repository/path/branch identity matches Git and dirty-state policy is satisfied. Automatic compensation additionally requires the checkout HEAD to remain at the resolved base; only an explicit cleanup action may remove a verified clean branch that advanced. A refused removal against a ready worktree leaves the creation ready and visible. Removing an owner-backed worktree atomically clears every conversation/card projection sharing its immutable worktree ID while preserving conversations and messages in the parent checkout. Adopted, external, conflicting, or legacy-unknown worktrees are never automatically deleted or branch-deleted.

Legacy paths are backfilled conservatively with `legacy` provenance. Migration creates cleanup authority only for one unambiguous, non-empty branch whose exact path is inside the independently derived `<project>/.switchboard/worktrees` root. Conflicting aliases, user-data paths without an independently trusted root, missing worktrees, and reused paths remain catalogued but non-cleanable. Explicit cleanup still revalidates the repository/path/branch tuple against Git; migration itself never deletes anything. The startup scan is limited to projections that still need canonical linkage, while later legacy writes remain eligible for backfill.

## Cross-surface impact

1. **Desktop Electron:** affected across preload/IPC, renderer state and progress UI, provider/terminal lifecycle, IDE CWD, fork/Kanban/new-chat entry points, cleanup UI, and tests.
2. **React Native/iOS:** affected. Add creation selection, durable client correlation, progress/recovery, explicit fallback, and authoritative returned metadata. Backend retains setup/startup/provider ownership.
3. **Native Android:** affected. Add equivalent intent/UI/coordinator behavior and Room-backed process-death recovery.
4. **Shared backend/API:** affected. Add typed contracts, progress events, capability negotiation, service, ports, and compatibility handlers.
5. **Storage/migrations:** affected. Add the catalog/journal, owner linkage, compatibility dual-write, conservative backfill, and upgrade tests.
6. **Update/release/rollout:** affected. New clients require `worktree_creation_v1` before offering remote worktree creation. Parent-checkout creation remains available explicitly. New backends keep old IPC/wire fields and route legacy creation through catalogued compatibility leases where possible. No client assumes simultaneous upgrade.

## Compatibility

- New client with old backend: capability-gate the worktree option and explain that the selected machine must be updated. Never fall back through the old unsafe flow after timeout or rejection.
- Old client with new backend: preserve legacy channels and optional path/branch fields. Legacy Desktop Git creation is wrapped as a catalogued compatibility lease that a subsequent legacy conversation write can claim; abandoned leases are reconciled or quarantined.
- Existing mobile with new backend: current conversation/card shapes and parent-checkout flows continue to work.
- New mobile with old backend: worktree creation is unavailable, while explicit parent-checkout creation remains supported.

## Test strategy

Primary behavioral tests target `WorktreeCreationService` with real in-memory SQLite and a fault-controllable Git/runtime boundary. They cover request validation, same-ID concurrency/retry, changed-payload conflict, distinct operations, per-repository locking and cross-repository concurrency, every phase failure, compensation, external-boundary retention, restart recovery, sparse ordering, setup resolution and receipts, atomic owner projections, provider/terminal ordering, exactly-once initial prompt, and correlated progress.

Real temporary Git repositories cover common-dir resolution, branch/path collisions, cone sparse checkout, dirty cleanup, prune behavior, and legacy imports. Thin renderer/mobile tests cover no optimistic publication, no silent fallback, durable correlation, process death, reconnect, and authoritative metadata. Compatibility tests cover old clients and optional legacy fields.

E2E scenarios cover Desktop new chat, Kanban creation/launch, fork-to-worktree, induced crash/restart, failure UI, and remote capability skew. Every E2E run must remove `$TMPDIR/sb-*` and `/tmp/sb-*` afterward as required by `AGENTS.md`.

Automated, Desktop manual, remote-machine, iOS hardware, Android hardware, and unexercised evidence are recorded separately in `docs/feature-parity/worktree-creation-transaction.json`.

## Invariants

- Every worktree creation entry point delegates to this service.
- A filesystem path is never a worktree identity or deletion authority.
- `projectPath` is stable product ownership; `worktreePath` is execution CWD.
- No setup/startup/provider work precedes durable worktree and owner identity.
- Same `creationId` cannot create a second worktree, owner, terminal, provider session, or initial prompt.
- Ambiguous external execution is reconciled, not blindly repeated.
- Explicit worktree intent never silently becomes parent-checkout execution.
- Live session, fork, or Kanban worktrees are never offered as stale merely because another projection is absent.
