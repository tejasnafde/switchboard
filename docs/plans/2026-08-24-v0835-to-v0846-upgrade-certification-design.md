# v0.8.35 to v0.8.46 Upgrade Certification

**Date:** 2026-08-24  
**Status:** Approved  
**Baseline:** Published desktop `v0.8.46` (`81f9787558d634ddc959b17bae1b168c144d4508`)  
**Fallback release:** Desktop `v0.8.47` and the next synchronized mobile releases when certification finds a defect

## Objective

Prove that a user actively working in desktop v0.8.35 can move to the v0.8.46 product line without losing data, breaking provider sessions, changing repository state, or stranding a mobile client. Certification covers the actual packaged desktop update boundary, the shared remote API, React Native/iOS, native Android, stored-data migration, and release-channel behavior.

The user's live v0.8.35 installation is outside the test boundary. It may remain running throughout the work. No test build may use its `userData` directory, database, credentials, terminals, provider processes, projects, worktrees, update preferences, or package identity.

## Considered approaches

### Validate only the v0.8.46 source tree

Running the current unit and type suites is fast, but it does not exercise migration from v0.8.35, packaged application behavior, updater metadata, or old mobile clients. This is insufficient.

### Rehearse against the user's live v0.8.35 profile

This offers realistic data, but opening it with a newer binary can run irreversible migrations and interfere with active work. Copying a live SQLite database without a coordinated backup can also produce an inconsistent snapshot. This is rejected.

### Isolated old-to-new packaged rehearsal plus contract audit

This is the selected approach. Build representative v0.8.35 fixtures in an isolated application-data root, exercise them with the packaged v0.8.35 binary, then upgrade that same isolated profile using the published v0.8.46 artifact. Combine that black-box path with schema/API contract tests, a source diff audit, and current-client verification. Any discovered defect is fixed from v0.8.46 and released forward; an already-published artifact is never rewritten.

## Safety and isolation

- Work occurs in a dedicated Git worktree based on the published v0.8.46 commit. The existing staged rollback remains untouched.
- Every Electron launch uses a test-only `userData` directory created under a unique temporary root.
- Packaged rehearsals use a test-only application identity or explicit user-data override so they cannot acquire the production single-instance lock or register production deep links.
- Tests use disposable repositories, provider stubs, credentials, ports, worktrees, and update feeds. They never connect to the user's running PTYs or provider processes.
- Fixtures contain synthetic secrets only. No live provider credential is copied.
- Temporary directories are tracked and removed after every packaged/E2E run, including failure and signal paths.
- No updater action is initiated on the user's installed application. Certification checks metadata and the isolated update target only.

## Upgrade fixture

The v0.8.35 fixture represents both ordinary and edge-case durable state:

- projects, nested project paths, archived and bookmarked conversations;
- provider instances in environment and OAuth-directory modes using fake encrypted values;
- provider session lineage and messages with images, plans, questions, tool activity, and file-diff attachments;
- drafts, layout, theme, terminal metadata, kanban cards, worktree linkage, and settings;
- clean, dirty, detached, missing, and stale disposable worktree states;
- update preferences and remote/mobile pairing records;
- SQLite WAL mode and an interrupted-shutdown copy produced through SQLite's backup mechanism.

The fixture is created by v0.8.35-owned schema/code rather than by reverse-engineering the v0.8.46 schema. Its expected invariants are recorded before upgrade and checked after v0.8.46 opens and settles.

## Cross-surface scope

### Desktop Electron

Exercise first launch, migration, relaunch, and representative workflows for projects, conversations, provider selection, message history, terminals, embedded IDE, kanban, worktrees, bookmarks, file diffs, settings, and update status. Confirm startup failure is recoverable and does not leave a half-migrated database.

### React Native/iOS

Verify that the released mobile client can list and open migrated conversations and handle v0.8.46 response shapes without dropping ambiguous or replayed turn outcomes. Verify the current client remains compatible with the same backend contract.

### Native Android

Run JVM contract/storage tests and, where hardware is available, install the debug application side-by-side without replacing production. Verify migrated conversation hydration, outbox retry, reconnect, and authoritative turn completion.

### Shared backend/API

Diff every wire-contract change from v0.8.35 through v0.8.46. Compatibility tests must cover authentication and scope enforcement, routing ownership, request idempotency, reconnect/replay, terminal-versus-chat subscriptions, and old-client decoding of newly valid response states.

### Stored data and migrations

Migrations must be additive or explicitly transformed, transactional, idempotent on relaunch, and safe across the direct v0.8.35-to-v0.8.46 jump. Foreign keys and integrity checks must pass. Existing paths, conversation IDs, lineage, provider-instance references, archive state, worktree identity, and user settings must remain stable.

### Update channels and release packaging

Verify that the desktop `latest` endpoint selects a desktop release with platform update manifests and artifacts. Mobile tags must not become the desktop Latest release. Validate package versions, signing/notarization evidence, architecture coverage, checksums, updater metadata, and rollback/recovery copy. A failed check blocks a successor release.

## Acceptance gates

1. The unmodified v0.8.46 source passes typecheck, unit/integration tests, mobile TypeScript checks, Android JVM tests, feature-parity validation, build, and smoke tests in the available environment.
2. A deterministic v0.8.35 fixture upgrades in place inside the isolated data root and passes invariants after first launch and second launch.
3. The packaged v0.8.35-to-v0.8.46 rehearsal passes on every locally buildable desktop architecture; unexercised OS/architecture combinations are named.
4. Released and current mobile clients pass shared-contract compatibility checks. Device checks are recorded separately from automated checks.
5. The audit findings covering updater selection, ambiguous mobile responses, renderer HTML trust, stuck dispatches, launch-root authorization, subscriber scopes, worktree deletion/recovery, parity evidence, and dependency advisories are either disproved by tests or fixed with a failing regression test first.
6. The production v0.8.35 process and its application-data directory are never opened, copied, migrated, or modified.
7. If fixes are needed, desktop v0.8.47 and synchronized mobile versions pass the full release workflow before publication. Release notes explicitly state the v0.8.35 direct-upgrade path.

## Failure handling

- A migration failure preserves the pre-upgrade fixture and emits an actionable error; it must not continue with partially migrated state.
- A response-loss or reconnect case returns the canonical stored result and never dispatches the same user turn twice.
- A worktree recovery failure retains user-authored or identity-changed state and reports exact cleanup instructions; it never force-deletes an advanced branch.
- A missing or wrong update manifest is an update-channel failure, not “already up to date.”
- Any unresolved data-loss, authorization, arbitrary HTML execution, duplicate-dispatch, or release-channel defect blocks publication.

## Verification report

The final report separates:

- automated source and contract tests;
- packaged desktop upgrade rehearsals by OS and architecture;
- iOS and Android device checks;
- release metadata and artifact inspection;
- checks not exercised in the available environment.

Passing compilation or unit tests alone is not described as cross-platform certification.
