# Worktree Creation Transaction Implementation Plan

**Design:** `docs/plans/2026-08-24-worktree-creation-transaction-design.md`
**Method:** Strict red-green-refactor at the public transaction boundary
**Target:** First release after v0.8.37

## Working rules

- Start every behavior with a focused failing test and run it to observe the expected failure before adding production code.
- Test `WorktreeCreationService` through its public interface. Use real in-memory SQLite and real temporary files; use controlled doubles only for Git/runtime failure injection that cannot be produced safely otherwise.
- Keep one backend coordinator. Compatibility handlers translate into its request; they do not preserve caller-side orchestration as a second implementation.
- Commit coherent green slices. Run targeted tests after each slice and the full cross-surface gates before completion.
- Preserve the primary checkout. Work only on `codex/worktree-creation-transaction` in the isolated worktree.
- Clean all `sb-*` temporary directories after every E2E invocation, pass or fail.

## Phase 1: Shared vocabulary, contracts, and validation

### Red

Add `tests/unit/worktree-creation-contract.test.ts` covering:

- complete conversation, Kanban, and fork envelopes;
- malformed/missing `creationId`, machine binding, repository, owner, purpose, and provenance;
- base ref and branch-seed rejection;
- namespace/purpose/owner mismatches;
- sparse directory normalization and rejection of absolute, empty, dot, traversal, and non-cone inputs;
- setup/launch combinations and mobile rejection of unauthorized ad hoc commands;
- stable canonical payload hashing independent of object key order;
- same creation identity with a changed payload producing a conflict shape.

Run the focused test and observe module/import failures.

### Green

Add `src/shared/worktree-creation.ts` with the versioned discriminated request, snapshot, receipt, error, recovery-action, and progress-event types plus pure parse/normalize/hash helpers. Add narrow channel constants to `src/shared/ipc-channels.ts` and capability `worktree_creation_v1` to `src/shared/ws-protocol.ts`.

Keep validation pure and exhaustive. Avoid accepting arbitrary filesystem destinations or Git command fragments.

### Verify

Run the new contract suite plus existing shared IPC/protocol tests and TypeScript checks for shared consumers.

## Phase 2: Canonical storage and upgrade/backfill

### Red

Add `tests/unit/worktree-creation-db.test.ts` and migration fixtures covering:

- creation reservation before Git;
- unique machine-scoped creation ID and exact payload hash;
- canonical worktree insertion plus conversation/card projections in one transaction;
- rollback when any projection write fails;
- multiple conversation/card projections sharing one immutable worktree ID;
- phase/revision compare-and-swap updates;
- catalog survival after owner/project deletion;
- legacy conversation-only, card-only, shared-path, missing-path, external-path, and conflicting-path backfill;
- old clients reading path/branch projections and writing legacy columns after migration;
- migration idempotency and upgrade from representative older schemas.

Observe failures before adding schema code.

### Green

Extend `src/main/db/database.ts` with the two tables, new linkage columns/indexes, and a transactional migration. Add a focused repository module under `src/main/worktree-creation/` for creation/worktree persistence, snapshot hydration, atomic owner projections, and conservative legacy import.

Do not swallow this migration's errors. Do not cascade catalog rows with projects or owners.

### Verify

Run database/migration suites using the real native SQLite binding.

## Phase 3: Git materialization and repository serialization

### Red

Add `tests/unit/worktree-git-adapter.test.ts` and temporary-repository integration cases for:

- canonical common-directory/repository resolution from the main checkout and an existing linked worktree;
- deterministic managed path and human-readable branch with stable creation suffix;
- valid base ref resolution;
- branch/path collisions never adopting unrelated state;
- per-repository FIFO exclusion;
- different repositories progressing concurrently;
- `git worktree add` before cone sparse configuration;
- normalized sparse directories and argument-array invocation;
- exact identity inspection for restart recovery;
- safe removal/branch cleanup only for the recorded managed identity;
- sibling-prefix containment rejection, dirty worktrees, missing directories, and prune metadata.

Observe the missing adapter/service behavior.

### Green

Refactor the useful low-level pieces of `src/main/worktree.ts` behind `GitWorktreePort` in `src/main/worktree-creation/git-worktree-adapter.ts`. Add a keyed repository mutex and managed-location policy. Preserve `execFile` argument arrays.

The existing helpers remain temporarily as compatibility callers but must delegate to the new materialization implementation before final migration.

### Verify

Run focused adapter tests and existing worktree/path/ref suites.

## Phase 4: Core saga, idempotency, compensation, and recovery

### Red

Add `tests/unit/worktree-creation-service.test.ts` as the primary surface. Cover:

- seven-state happy path with one worktree, one owner, and correlated progress;
- simultaneous and later same-ID/same-payload retries returning one operation;
- same ID with changed request hard-conflicting;
- distinct IDs producing distinct worktrees;
- progress isolation by creation ID;
- caller disconnect not cancelling backend execution;
- failure at reserve, materialize, sparse configure, link, setup decision, setup, startup, provider, prompt, and final acknowledgment;
- compensation before external commands;
- `cleanup_required` retention after the mutation boundary;
- restart recovery from every persisted nonterminal state;
- exact Git-state adoption only for the same recorded operation;
- revision-checked cancel/retry/retain/remove actions;
- setup ambiguity never blindly rerunning the command;
- query after event loss returning the authoritative snapshot.

Run individual red cases as they are added.

### Green

Implement `src/main/worktree-creation/worktree-creation-service.ts` with the three public methods and private saga transitions. Inject the storage repository, Git port, owner linker, setup runner, startup launcher, progress sink, path policy, clock, and ID generator. Persist every phase before crossing its boundary.

Keep expected failures structured. A transport timeout after mutation returns a pending/ambiguous snapshot, not definite rejection.

### Verify

Run service tests repeatedly, including concurrent cases, then the entire worktree test family.

## Phase 5: Owner adapters and entry-point migration

### Conversation/new-chat owner

Write failing tests proving conversation identity and worktree projections commit together and no renderer session is published before `ready` or a recoverable linked state. Implement the conversation owner adapter and remove renderer-owned worktree persistence.

### Kanban owner

Write failing tests for new card plus worktree, existing card attachment, blocked backlog-card preservation, retry, explicit parent-checkout action, existing linked-conversation reuse, and no accidental partial state. Implement Kanban owner intent and replace create/attach/auto-launch orchestration with the service.

### Fork owner

Write failing tests for transcript-artifact failure, JSONL/rollout copy, database failure, compensation, provider-specific degraded resume, lineage, and `projectPath`/`worktreePath` separation. Implement staged artifact preparation/commit/compensation in the fork owner adapter and route all worktree forks through the saga.

### Compatibility projections

Add tests that older callers can still load conversations/cards with path/branch fields. Legacy creation handlers become catalogued compatibility leases and later exact projection writes claim them. Abandoned or mismatched leases reconcile to safe visible states.

## Phase 6: Setup policy and launch-config preservation

### Red

Extend launch-config parser/serializer/reducer/editor tests for:

- additive `worktree.setup.command`;
- `ask | run | skip` repository defaults;
- `wait-for-setup | start-immediately` startup policy;
- round-trip preservation in the Settings editor;
- invalid values producing actionable validation;
- `inherit`, `run`, and `skip` resolution;
- absent, successful, failed, and ambiguously interrupted setup receipts;
- no inferred package-manager command;
- config source root distinct from worktree CWD.

### Green

Extend `src/shared/launch-config.ts`, the launch-config store/editor, and Settings UI. Add a setup runner that records a safe source/fingerprint and outcome without secrets. Execute only explicit checked-in or authorized Desktop-supplied commands on the bound machine.

Update `docs/launch-configs.md` in the same slice.

## Phase 7: Backend-owned startup resources and initial prompt

### Red

Add tests proving:

- durable identity/ownership precedes setup, terminal, provider, and prompt calls;
- terminal layouts use stable handles and worktree CWD;
- retry/reconnect adopts existing handles rather than spawning duplicates;
- `wait-for-setup` and `start-immediately` ordering;
- provider starts in returned `worktreePath`;
- initial prompt uses one stable atomic origin and is accepted exactly once;
- ambiguous prompt delivery reconciles through durable turn acceptance;
- provider/startup failure retains a potentially modified worktree;
- renderer never creates a fallback PTY/provider session.

### Green

Extract an idempotent terminal runtime port from the existing terminal IPC manager. Add a workspace startup launcher that reads the selected/default config, returns stable handles, and is callable by the service. Expose narrow idempotent provider start and atomic prompt methods from `ProviderRegistry` without exposing adapter internals.

Update terminal/IDE lifecycle to adopt authoritative startup receipts and consistently use `projectPath` for grouping/config identity and `worktreePath` for execution.

## Phase 8: Host API, progress, routing, and version skew

### Red

Add real host/transport tests for:

- create/get/action over Electron and WebSocket hosts;
- authenticated machine binding before filesystem mutation;
- progress replay and authoritative query after reconnect;
- concurrent progress streams;
- phone-scope command restrictions;
- new client/old backend capability gating;
- old client/new backend compatibility handlers;
- definite unsupported-backend response distinguished from timeout ambiguity.

### Green

Register typed backend handlers, preload methods, and replayable `worktree.creation.progress`. Extend backend request context with the authenticated data needed for policy. Route creation directly to the selected stable machine before any thread exists.

Do not route a new-worktree request by a not-yet-created conversation ID.

## Phase 9: Desktop state and recovery UI

### Red

Add component/service tests for:

- explicit parent-checkout versus worktree selection;
- no optimistic ready session/sidebar entry;
- phase-based progress without percentages;
- definite failure preserving editable owner/prompt intent;
- Retry, Start in project, retain, and removal actions;
- no silent fallback;
- unmount/crash followed by replay/query hydration;
- fork and Kanban sessions hydrating stable `projectPath`, `worktreePath`, and branch;
- Worktree Manager refusing live, adopted, external, mismatched, or dirty worktrees.

### Green

Add one compact shared Desktop progress/recovery component and a small creation store keyed by `creationId`. Migrate `App.tsx`, Kanban card flows, and fork opening to the host API. Publish Zustand sessions only from authoritative metadata.

Replace stale detection/removal with catalog-backed inventory and verified actions. Remove the three old renderer-owned creation paths.

## Phase 10: React Native/iOS

### Red

Add tests for:

- capability-gated parent-checkout/worktree selection;
- stable `creationId` and editable launch intent persisted until terminal result;
- progress/query after reconnect and app restart;
- same-ID retry, changed-payload conflict, and explicit fallback;
- rejected setup/worktree preserving the initial prompt and selections;
- navigation using authoritative project/worktree/branch metadata;
- old-backend behavior and old conversation compatibility.

### Green

Extend the mobile API/types and New Session screen. Add a durable local launch-intent journal using the existing preference/storage conventions. The client submits intent and observes/query snapshots; it does not separately start the provider or enqueue the first prompt for worktree-backed creation.

Run mobile Jest and TypeScript checks.

## Phase 11: Native Android

### Red

Add coordinator, repository, Room migration, and UI-state tests for:

- stable creation ID across process death;
- query-before-retry after reconnect;
- correlated progress and recovery actions;
- capability gating and explicit parent checkout;
- authoritative returned path metadata;
- preserved prompt/owner intent after rejection;
- old backend and old stored-conversation compatibility.

### Green

Extend the shared wire DTOs and `NewSessionCoordinator`, add equivalent new-session UI, and add the minimal Room entity/migration needed for pending creation recovery. Backend results—not local reconstruction—populate conversation navigation metadata.

Run relevant Gradle unit tests after every Android slice.

## Phase 12: Legacy reconciliation and cleanup safety

### Red

Add end-to-end catalog tests proving:

- live new-chat, fork, and Kanban worktrees are never stale;
- ownerless managed worktrees are visible but require verified cleanup;
- adopted/user-created Git worktrees are never removable by managed cleanup;
- legacy missing/reused/conflicting paths stay quarantined;
- project/card/conversation deletion does not erase cleanup evidence;
- removal matches canonical repository, immutable worktree ID, exact path/branch, owner set, and dirty-state observation;
- branch cleanup works for managed `sb`, `fork`, and `kanban` branches only.

### Green

Complete startup reconciliation, legacy-column import, manager inventory, retirement/removal actions, and cleanup UI. Delete or reduce obsolete helpers once all call sites route through the service.

## Phase 13: Documentation, parity, review, and verification

Update:

- `docs/feature-parity/worktree-creation-transaction.json`;
- launch-config specification and examples;
- worktree, fork, and Kanban documentation;
- `docs/notes/session-kickoff-fork-to-worktree.md`;
- `docs/notes/kanban-gap-audit.md`;
- `docs/notes/roadmap-deferred.md` and `docs/plan.md` where claims became obsolete;
- release notes/rollout guidance for `worktree_creation_v1`.

Run targeted suites first, then:

```sh
npm --prefix apps/mobile run typecheck
npm --prefix apps/mobile test -- --runInBand
cd apps/android && ./gradlew test
npm run typecheck
npm test
npm run build
npm run validate:feature-parity -- --base origin/main
```

Run real-Git and transport E2E tests. After every E2E command, including failures:

```sh
rm -rf "$TMPDIR"sb-* /tmp/sb-*
```

Perform adversarial Claude and Codex reviews, fix confirmed findings with new failing regression tests, run deslop review, and repeat the full verification gate.

Record separately in the parity manifest:

- automated results;
- local Desktop creation and failure/restart smoke;
- remote-machine creation/reconnect smoke;
- iOS hardware verification;
- Android hardware verification;
- every unexercised scenario.

## Commit sequence

1. Shared contract and validation.
2. Schema, repository, and legacy migration.
3. Git adapter and repository serialization.
4. Core saga and recovery.
5. Conversation/Kanban/fork owner adapters.
6. Setup configuration and runner.
7. Terminal/provider/startup ownership.
8. Host API, progress, routing, and compatibility.
9. Desktop UI/state/cleanup migration.
10. React Native/iOS flow.
11. Android flow and Room migration.
12. Documentation, parity, E2E, and review fixes.

Each commit must be independently type-correct and green for its relevant targeted tests. Compatibility wrappers remain until their replacement is verified and are removed only when doing so does not break supported mixed-version clients.
