# Conversation Fork Reliability Implementation Plan

**Design:** `docs/plans/2026-08-24-conversation-fork-reliability-design.md`
**Method:** Strict red-green-refactor at the backend fork boundary
**Target:** Next Switchboard release after v0.8.43 and synchronized mobile releases

The `writing-plans` skill referenced by the brainstorming workflow is not installed in this session. This document is the equivalent executable plan.

## Working rules

- Add one focused failing behavioral test, run it, and observe the expected failure before each production change.
- Keep `ConversationForkCoordinator` as the only fork orchestrator. Clients translate UI intent into its contract and consume its result.
- Delegate every Git materialization/rollback to `WorktreeCreationService`; do not restore legacy `createForkWorktree` orchestration.
- Use real in-memory SQLite with foreign keys enabled for transaction tests and real temporary Git repositories for repository-state tests.
- Freeze source inputs before any artifact or Git side effect. A retry never reloads live source history or HEAD.
- Commit coherent green slices and keep unrelated Desktop Markdown, navigation, worktree-transaction, and provider-support changes out.
- Preserve the primary checkout; all work happens in the isolated `codex/conversation-fork-reliability` worktree.
- After every E2E invocation, remove `$TMPDIR/sb-*` and `/tmp/sb-*` whether it passes, fails, or crashes.

## Phase 1: Shared fork contract and canonical digests

### Red

Add `tests/unit/conversation-fork-contract.test.ts` covering:

- complete shared-checkout and new-worktree requests;
- required schema version, request ID, source conversation, anchor and provenance;
- rejection of malformed IDs, timestamps, digests, checkout variants and confirmation receipts;
- canonical request equality independent of object-key order;
- changed payload under one request ID producing an idempotency conflict;
- exhaustive completed, confirmation-required and typed failure decoding;
- authoritative conversation, resume, Git, warning and recovery fields.

Add digest cases for content, images, image-only messages, tool calls, pills/display body, plan/question/todo/file-diff attachments, null optionals and stable object ordering. Observe module/import failures.

### Green

Add `src/shared/conversation-fork.ts` with the versioned request/outcome/result, warning/error/recovery, anchor/provenance and pure parse/canonicalize/digest helpers. Add `conversation_fork_v1` to shared capabilities and retain one `AppChannels.FORK_CONVERSATION` channel with the new envelope.

### Verify

Run the new contract suite plus shared IPC, wire and provider-event tests.

## Phase 2: Canonical forkable history and anchor resolution

### Red

Add `tests/unit/conversation-fork-anchor.test.ts` covering:

- exact durable-ID resolution;
- stale role, timestamp or digest rejection;
- missing anchor;
- duplicate identical messages inside sixty seconds returning `anchor-conflict`;
- unique legacy fingerprint fallback;
- renderer-only fork notice and provider/profile marker exclusion;
- live versus reloaded `result` events;
- mixed-provider segment provenance;
- second-generation fork IDs;
- image-only user message;
- non-forkable transient tool/activity/status rows.

Extend history/parser tests to expose stable Claude UUID/Codex ID provenance without changing visible dedupe semantics.

### Green

Add a narrow fork snapshot/anchor module under `src/main/conversations/`. Deepen `loadConversationHistory` or its return model so each canonical durable message has forkability and optional provider segment/session/event provenance. Resolve exact IDs first and legacy fingerprints only when unique. Delete the fuzzy first-match behavior from the fork path.

Expose a pure helper the Desktop and mobile presentations can use to decide whether an action is available; clients still do not resolve the anchor.

### Verify

Run anchor, JSONL parser/truncation, dedupe and conversation-history suites.

## Phase 3: Durable operation journal and migration

### Red

Add `tests/unit/conversation-fork-store.test.ts` with real SQLite and `PRAGMA foreign_keys = ON` covering:

- additive `conversation_fork_operations` schema and conversation metadata;
- reservation before external side effects;
- unique machine/request identity and exact payload hash;
- frozen prepared snapshot round trip;
- revision-checked phase transitions;
- same key/same hash replay and changed-hash conflict;
- operation-result and conversation visibility in one transaction;
- rollback when message, metadata or result insertion fails;
- process restart returning the serialized result;
- migration idempotency from representative older schemas.

### Green

Add `src/main/db/conversation-fork.ts` with schema installation, reservation/query/CAS helpers and one atomic completed-fork commit. Wire additive migrations from `src/main/db/database.ts`. Extend `ConversationRow` with the durable settings, anchor/resume/lineage projections required by the result.

Do not add a foreign machine relationship to conversations. Store operation machine ownership/provenance in the journal.

### Verify

Run store/migration tests twice against the real native binding.

## Phase 4: Exhaustive rich-message cloning

### Red

Add `tests/unit/conversation-fork-message-copy.test.ts` covering:

- all `ChatMessage` durable fields;
- image-only messages with empty content;
- tool calls and outputs;
- display bodies and pill metadata;
- plan, question, todos, file diff, denial and supported durable attachments;
- deterministic order;
- new backend-generated IDs;
- returned messages exactly matching persisted/reloaded messages;
- unsupported attachment behavior returning a warning/error instead of omission.

Add an injected mid-copy failure proving no conversation or completed operation row survives.

### Green

Create one exhaustive durable message codec/projection used by both ordinary and worktree fork commits. Extend message persistence columns only where the current schema cannot represent an already-supported durable attachment. Remove `toMessageRow()` and fork use of shallow `bulkSaveMessages()`.

### Verify

Run message-copy, message persistence, pills/images and full fork-store tests.

## Phase 5: Source execution projection

### Red

Add `tests/unit/conversation-fork-source-profile.test.ts` covering:

- agent type, committed provider instance, runtime mode, model and reasoning effort;
- launch config and source machine provenance where applicable;
- non-default Claude profile;
- missing/disabled source profile;
- mixed-provider current selection versus older anchor segment;
- parent `projectPath`, source `worktreePath` and source checkout separation;
- authoritative returned fields equal persisted fields.

### Green

Add one database-backed source execution projection function. Update conversation row mapping/migrations for any setting not yet durable. Pass this immutable projection into resume planning, persistence and result construction. No fork provider path may call `resolveProviderInstance(..., null)`.

### Verify

Run profile switch, conversation segment, session eviction and new source-profile tests.

## Phase 6: Plain-fork coordinator and atomic happy path

### Red

Add `tests/unit/conversation-fork-coordinator.test.ts` covering:

- one shared-checkout fork with exact prefix and authoritative state;
- same request concurrently and after response loss returning one conversation;
- changed request conflict;
- source history advancing after reservation without changing the fork;
- second-generation fork after restart;
- anchor conflict before side effects;
- full DB rollback on every injected commit failure;
- durable lineage and banner metadata.

### Green

Implement `ConversationForkCoordinator.createOrGet()` and `get()` under `src/main/conversations/`. Reserve/freeze, plan provider continuity, stage an artifact if needed, then atomically commit the operation/conversation/messages/result. Add a narrow artifact port with prepare/publish/compensate receipts.

Replace the provider-specific branching in `fork.ts`; retain a compatibility export only if tests/imports require it during migration.

### Verify

Run coordinator, store, anchor and rich-message suites.

## Phase 7: Provider resume planner and artifacts

### Claude red

Add fixtures/tests for:

- same committed instance native resume;
- non-default OAuth profile target directory;
- exact target worktree CWD encoding;
- compaction-spanning compatible fragments;
- rewritten session/root/CWD/native identity fields based on observed schema;
- anchor outside compatible lineage degrading explicitly;
- missing fragment/profile and conflicting native provenance;
- artifact publication failure and exact compensation;
- retry using frozen fragment bounds after source transcript growth.

### Claude green

Refactor `jsonl-truncate.ts` from positional visible counts to a provenance-aware native boundary. Keep provider schema parsing inside its adapter. Write only the new frozen fork session artifact in the source committed profile and return a native hint only when every compatibility check passes.

### Codex/OpenCode red

Add tests proving both persist `transcript-handoff`, no Codex `rollout-fork-*` enters discovery, no fake resumable hint is returned, and audit material—if any—lives outside provider session trees.

### Codex/OpenCode green

Remove rollout publication from fork code. Use no provider artifact for cold handoff unless Switchboard-owned audit storage is needed.

### Verify

Run JSONL, fragment path, provider profile, scanner and provider-specific fork suites.

## Phase 8: Exactly-once handoff and persistent fork status

### Red

Extend atomic user-turn tests for:

- handoff pending after fork creation and restart;
- frozen preamble injected on the first accepted user turn;
- preparation/provider rejection preserving pending handoff;
- ambiguous first send reconciling the same origin;
- accepted duplicate not dispatching/replaying again;
- atomic handoff marker and state clear;
- restart after acceptance showing completed handoff status;
- persistent native/handoff fork banner independent of messages.

### Green

Replace renderer-only `system_fork_notice_*` insertion with typed fork metadata loaded beside session history. Extend the existing durable user-turn acceptance seam only as needed to bind a specific frozen fork handoff receipt and status transition.

### Verify

Run atomic turn, handoff preamble, rotation fallback, renderer/mobile handoff suites.

## Phase 9: Git source receipt and worktree-owner integration

### Red

Extend `worktree-creation-git-adapter.test.ts`, `worktree-creation-fork-owner.test.ts`, `worktree-creation-fork-store.test.ts` and add coordinator integration cases for:

- exact source checkout HEAD SHA;
- clean main checkout;
- dirty tracked and untracked status receipts;
- confirmation required before creation;
- changed HEAD/status invalidating confirmation;
- source already in a worktree, canonical root target and no nesting;
- branch/path collision;
- materialization from exact SHA;
- frozen stage passed to owner without history reload;
- Git/artifact/DB failure compensation;
- cleanup failure receipt and dirty retained worktree;
- same request creating one branch/worktree;
- successful fork counted as in-use;
- explicit `fork/` removal policy rather than Kanban-only assumptions.

### Green

Add source checkout inspection/status digest to the existing Git port. Update fork worktree request/owner types to carry request ID, frozen anchor/preparation and exact source SHA rather than `upToIndex` or renderer conversation ID. Deepen `ForkWorktreeOwnerPort` and `commitForkOwner()` so the fork journal result, canonical worktree, complete conversation/settings and rich messages commit atomically.

Remove remaining direct fork calls to `createForkWorktree()`.

### Verify

Run the entire worktree creation, compensation, recovery, liveness and legacy removal family.

## Phase 10: IPC, preload, routing and remote recovery

### Red

Add/extend routing, transport, host and preload tests for:

- `sourceConversationId` recognized as a routing key;
- explicit machine/source binding mismatch rejected;
- unknown remote source failing closed instead of local fallback;
- remote backend receiving create/get;
- response-loss retry returning the original result;
- returned conversation ID bound before activation;
- future provider, terminal, IDE, files, Git, archive and fork calls resolving to the same machine;
- capability/version-skew behavior;
- legacy positional request returning update-required, not executing unsafely.

### Green

Update `src/main/ipc/app.ts`, `src/preload/index.ts`, routing table/router and shared capability advertisement. Expose typed create/get fork methods. Ensure Desktop binds routing before store publication. Remote execution remains source-machine-owned and never fails over locally.

### Verify

Run routing table, transport router, IPC host/wire, remote bridge and fork remote tests.

## Phase 11: Desktop actions, state, errors and lineage UI

### Red

Add service/component tests covering:

- actions only on forkable canonical messages;
- exact stable anchor request, no array index;
- precise action wording;
- dirty-source confirmation with SHA and omitted-change warning;
- same request ID across Retry and unknown completion;
- typed anchor/Git/artifact/persistence/cleanup/disconnect errors;
- exact returned messages and settings hydrated;
- worktree metadata and CWD projection;
- dual-chat source slot preserved;
- routing bind before add/activate;
- sidebar row immediately visible;
- durable lineage/resume banner and parent navigation to exact anchor;
- no synthetic notice or rescan dependency.

### Green

Rewrite `src/renderer/services/forkSession.ts` around the authoritative result. Update `MessageBubble.tsx` eligibility/menu/progress/confirmation wording and add a compact `ForkLineageBanner`. Extend agent/store/session hydration for fork metadata without creating another renderer source of truth.

### Verify

Run renderer fork, message-bubble, routing, store, sidebar and lineage suites plus renderer typecheck.

## Phase 12: React Native/iOS parity

### Red

Add mobile tests for:

- long-press actions only for forkable transcript items;
- typed API request/outcome decoding;
- dirty confirmation and typed failures;
- request ID retained across app restart/reconnect;
- same-ID query before retry;
- authoritative project/worktree/branch/machine/profile/model/mode hydration;
- navigation CWD using `worktreePath ?? projectPath`;
- persistent lineage/resume banner and parent-anchor navigation;
- old backend capability gating.

### Green

Extend `apps/mobile/src/lib/api.ts`, navigation types/state, thread item model and `ThreadScreen.tsx`. Persist pending fork intent/result correlation using existing AsyncStorage conventions. Do not reconstruct or separately create conversations/worktrees.

### Verify

Run focused mobile Vitest/Jest suites and the React Native TypeScript check.

## Phase 13: Native Android parity

### Red

Add Kotlin unit/UI regression tests for:

- fork request/result wire models and decoders;
- stable request ID across process recreation;
- query-before-retry and no duplicate fork;
- long-press actions and non-forkable exclusions;
- dirty confirmation and typed failure/recovery state;
- authoritative parent project/worktree/branch/machine/profile/model/mode navigation;
- provider/terminal/IDE CWD projection;
- persistent lineage/resume banner and exact parent anchor;
- capability gating and old stored conversation compatibility.

### Green

Extend Android remote models/client/decoders, `ThreadSessionCoordinator`, snapshot/Room persistence, navigation state and Compose thread UI. Decorative actions remain accessible and process death resumes by request ID.

### Verify

Run focused Gradle unit and Compose tests, then Android unit/lint/assemble/androidTest compilation gates.

## Phase 14: Legacy diagnostics, repair and documentation

### Red

Add classifier/migration tests for:

- healthy;
- legacy project path equal to worktree path;
- missing worktree;
- orphan managed worktree;
- ambiguous/missing anchor;
- unusable Codex native artifact;
- unambiguous parent-project repair;
- no destructive startup cleanup;
- conflicting evidence remaining diagnostic-only.

### Green

Add a narrow read-only diagnostic module and conservative transactional repair for only unambiguous parent project identity. Integrate explicit cleanup with the canonical worktree transaction actions; never delete paths/artifacts during migration.

Replace stale claims in:

- `docs/notes/session-kickoff-fork-from-message.md`;
- `docs/notes/session-kickoff-fork-to-worktree.md`;
- `docs/notes/roadmap-deferred.md`;
- `docs/plans/2026-08-12-long-conversation-lineage-design.md`;
- `docs/plan.md`;
- `README.md`.

### Verify

Run diagnostic/migration/document contract tests and search for obsolete positional/Codex-resume claims.

## Phase 15: Feature parity, adversarial review and release

1. Add `docs/feature-parity/conversation-fork-reliability.json` with concrete evidence for Desktop, React Native/iOS, Android, shared API, storage/migration and release/rollout.
2. Run focused fork/JSONL/DB/worktree/routing/renderer/mobile/Android tests.
3. Run `npm run typecheck`, `npm test`, `npm run build`, mobile TypeScript/tests, Android unit/lint/assemble/androidTest compilation and feature-parity validation against the rebased base ref.
4. Run `connectedDebugAndroidTest` only when an emulator/device is available and report it separately.
5. Perform the approved live Claude verification with disposable sessions in `~/.claude-tech-team` and `~/.claude-tejas`. Verify native first-follow-up context without handoff injection and non-default-profile continuity.
6. Manually exercise Codex/OpenCode handoff, fork-after-restart, clean/dirty/nested worktrees, rich attachment reload, lineage navigation, compensation and same-request retry.
7. Exercise a real remote-machine fork when a configured machine is available; otherwise report it as unexercised rather than substituting local compilation.
8. Use `claude-code-review` for an adversarial branch review. Fix every confirmed finding with a new failing regression test and rerun the gates.
9. Rebase onto current `origin/main`, rerun parity validation and all affected gates, then follow `docs/releasing.md` to cut the authorized release.
10. Verify the published release/tag/assets/workflow and report automated, emulator/device, provider-profile, remote and unexercised evidence separately.

## Commit sequence

Prefer one green commit per coherent phase:

1. shared contract and anchor;
2. journal/migration and rich-message transaction;
3. coordinator and source projection;
4. provider resume/handoff;
5. worktree integration;
6. routing/IPC;
7. Desktop UI/state;
8. React Native/iOS;
9. Android;
10. diagnostics/docs/parity;
11. adversarial fixes and release metadata.

Do not advance a phase while its focused tests are red for an unexplained reason.
