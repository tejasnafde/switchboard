# Reliable Conversation Forking

**Date:** 2026-08-24
**Status:** Approved
**Target:** Next Switchboard release after v0.8.43 and next synchronized mobile releases

## Objective

Make “Fork conversation here” and “Fork conversation into a new worktree from current HEAD” one backend-owned, idempotent, recoverable operation. A client identifies the source conversation, supplies a verifiable transcript anchor and an explicit checkout policy, then consumes one authoritative result. It never chooses a fork conversation ID, worktree path, provider-native resume cursor, or transcript position.

This change deepens the first-class `WorktreeCreationService` that landed on 2026-08-24. It does not introduce a competing Git orchestration path.

## Verified failures

The investigation confirmed the reported defects:

- The current IPC treats renderer `upToIndex` as authoritative even though the backend independently reloads and merges history.
- `resolveNativeForkIndex` accepts the first repeated role/content/timestamp match within sixty seconds.
- Parsed Claude UUIDs and Codex provider IDs/content hashes are stable where native data supplies them; the kickoff note claiming all IDs regenerate is stale.
- Plain forks have no durable request journal. A response-loss retry can create another conversation and provider artifact.
- The current non-worktree provider branches insert the conversation, messages and handoff through separate writes.
- The current fork message projection copies only role/content/timestamp, skips image-only messages, drops rich attachments, and returns source IDs instead of the IDs stored in SQLite.
- Cold-fork status is a renderer-only synthetic message and disappears after restart.
- `RoutingTable` does not recognize `sourceConversationId`, so a remote fork without an explicit machine can fall back locally.
- Claude artifact preparation resolves the default provider instance instead of the source conversation’s committed instance.
- Codex writes non-resumable `rollout-fork-*` files into its discovery tree.
- Worktree fork preparation still reloads history by `upToIndex` and copies shallow messages, although the landed owner transaction now preserves parent `projectPath` and compensates pre-commit Git/artifact failures.
- Nested worktree placement is fixed at the Git adapter seam only when the canonical repository is resolved first; the current fork request still supplies a branch ref rather than the source checkout’s exact HEAD.
- Current UI wording does not make dirty-source omissions or current-HEAD filesystem semantics sufficiently explicit.

## Considered designs

### Retrofit the provider branches in `fork.ts`

Adding IDs, richer inserts and compensation separately to the Claude, Codex and OpenCode branches would reduce the first diff. It was rejected because shared-checkout and worktree forks would retain different idempotency, recovery and commit models.

### Reuse `WorktreeCreationRequest` for every fork

Adding an artificial `in-place` checkout variant would give plain forks access to the existing journal. It was rejected because conversation branching is meaningful without Git materialization. Making the worktree service own non-Git transcript operations would shallow both modules.

### Conversation fork coordinator plus the existing worktree saga

This is the selected design. A deep `ConversationForkCoordinator` owns request validation, source snapshot freezing, anchor resolution, provider resume planning, idempotency, persistence and authoritative results. Shared-checkout forks commit directly through its store. New-worktree forks delegate materialization and rollback to `WorktreeCreationService` through a deepened fork-owner port.

## Public contract

The shared, versioned request is:

```ts
type ForkAnchor = {
  messageId: string
  role: ChatMessage['role']
  timestamp: number
  contentDigest: string
}

type ForkConversationRequest = {
  schemaVersion: 1
  requestId: string
  sourceConversationId: string
  machineId?: string
  anchor: ForkAnchor
  checkout:
    | { kind: 'shared-checkout' }
    | {
        kind: 'new-worktree'
        basePolicy: 'source-head'
        dirtySourceConfirmed?: {
          headSha: string
          statusDigest: string
        }
      }
  provenance: {
    surface: 'desktop' | 'react-native' | 'android' | 'automation'
    requestedAt: number
  }
}
```

`requestId` is generated once by the client and retained across reconnects, process restoration and explicit Retry. Reusing it with a different canonical payload is a typed `idempotency-conflict`.

The backend returns either a typed intermediate outcome or a terminal authoritative result:

```ts
type ForkConversationOutcome =
  | { kind: 'confirmation-required'; requestId: string; dirtySource: DirtySourceReceipt }
  | { kind: 'completed'; result: ForkConversationResult }
  | { kind: 'failed'; error: ForkError; recovery?: ForkRecoveryReceipt }

type ForkConversationResult = {
  requestId: string
  conversation: {
    id: string
    projectPath: string
    worktreePath: string | null
    worktreeBranch: string | null
    worktreeId: string | null
    machineId?: string
    agentType: AgentType
    providerInstanceId: string | null
    runtimeMode: RuntimeMode
    model: string | null
    reasoningEffort: ReasoningEffort | null
    launchConfigName: string | null
    title: string
    parentConversationId: string
    anchor: ResolvedForkAnchor
    resumeMode: 'native' | 'transcript-handoff'
    createdAt: number
  }
  messages: ChatMessage[]
  nativeResume?: { provider: 'claude'; sessionId: string }
  git?: {
    baseSha: string
    path: string
    branch: string
    sourceDirty: boolean
    omittedChangeSummary?: string
  }
  warnings: ForkWarning[]
}
```

The operation is queryable by `requestId`. Clients do not reconstruct resume capability, checkout identity, profile selection or lineage from optional fragments.

## Canonical snapshot and anchor resolution

`ConversationForkCoordinator` loads one canonical ordered history snapshot through the existing conversation-history seam. The snapshot combines provider segments and the SQLite mirror using the current history rules, but exposes durable message identity and provider provenance rather than making a second ancestry model.

The coordinator resolves an anchor in this order:

1. Find the exact canonical message ID.
2. Validate role, timestamp and a versioned digest of the complete durable message payload, not content alone.
3. For legacy rows whose exact ID is unavailable, calculate the same fingerprint for every candidate and accept only one unique match.
4. Return typed `anchor-conflict` for zero, stale or multiple matches. Never choose the first candidate.
5. Derive the prefix from the resolved backend snapshot and return its canonical index/count as evidence, not as future authority.
6. Resolve provider-native provenance independently. Native resume requires one exact compatible native event; missing or ambiguous provenance degrades to transcript handoff.

The digest covers role, provider-visible content, images, tool calls and durable structured attachments in canonical encoding. Display-only transient runtime activity is excluded from canonical history and cannot be forked. The Desktop context menu and mobile actions appear only for messages carrying a forkable anchor. A durable attachment-only user message is forkable.

## Frozen preparation and idempotency

The first successful reservation freezes the entire fork input before external side effects:

- resolved anchor and canonical message prefix;
- complete rich-message payloads;
- source execution projection;
- provider-native segment/event provenance and exact fragment byte bounds;
- canonical parent repository, source checkout, exact source HEAD and dirty-status receipt;
- requested checkout policy;
- canonical request and prepared-payload hashes.

Every retry uses this frozen payload. It never reloads a newer transcript prefix or a later source HEAD. A bounded reference is allowed only when it addresses immutable Switchboard-owned content; it cannot point into a live provider transcript.

The `conversation_fork_operations` table is keyed by authoritative source machine plus `request_id` and stores schema version, request hash, source and result conversation IDs, phase/status/revision, frozen preparation JSON/reference, artifact receipt, worktree creation linkage, serialized result/error/recovery receipt and timestamps.

For a completed fork, the operation row, forked conversation, settings, lineage, cloned messages, pending handoff and result projection commit in the same SQLite transaction. This prevents a conversation from existing without a request result that can be recovered after response loss.

Machine ownership and transport reachability remain distinct. The source backend is the only backend allowed to execute the operation. Machine provenance is durable in the operation result; live reachability stays in transport state. A disconnected source produces `disconnected` or `completion-unknown` and never fails over locally.

## Persistence model

Additive conversation metadata records:

- resolved anchor ID, digest, role, timestamp and canonical count;
- provider/native provenance needed for lineage navigation;
- `resume_mode` and durable fork status;
- provider instance, runtime mode, model and reasoning effort;
- worktree ID/path/branch and base SHA where applicable;
- parent conversation and parent title/anchor preview projection;
- pending transcript-handoff identity and acceptance state.

The existing `parent_conversation_id` remains user-created fork lineage. `thread_sessions` remains provider-session rotation lineage and is not overloaded.

Messages receive backend-generated IDs before the transaction. Those exact rows are inserted and converted back to the returned `ChatMessage[]`. Copying uses one exhaustive durable-message codec. It preserves content, images including image-only messages, tool calls, display bodies, pills, plans, questions, todos, file diffs and other durable attachments. Unsupported attachment kinds fail with a documented warning/error; they are never silently omitted.

SQLite foreign keys stay enabled in integration tests. `project_path` always remains the canonical parent project path. `worktree_path` remains execution CWD.

## Provider resume planning

### Claude

Native resume is allowed only when:

- the target provider is Claude;
- the resolved anchor belongs to compatible Claude foreground lineage;
- the source conversation’s committed provider instance exists and owns all required transcript copies;
- the native event mapping is exact;
- transcript assembly can rewrite all verified native session/root/CWD identity fields for the target checkout.

The target transcript is written into that same provider profile’s correctly encoded target CWD directory. The new session ID is backend-generated and returned as `nativeResume`. A live verification must prove the first follow-up has context without a transcript handoff.

If any compatibility check fails, the operation persists `transcript-handoff` with a concrete warning. It never silently selects the current default profile.

### Codex

Codex uses transcript handoff until app-server resume is wired and proven. The fork does not write `rollout-fork-*` into normal provider discovery trees. Optional audit material, if retained, lives in Switchboard-owned operation storage and is not presented as resumable.

### OpenCode

OpenCode uses transcript handoff until ACP exposes a compatible verified resume primitive.

### Mixed-provider history

The fork preserves the source conversation’s currently selected provider/profile. An anchor in an older provider segment allows native resume only when that segment is compatible with the selected target provider and profile. Otherwise it uses transcript handoff. Similar text in another segment is never a provenance signal.

## Exactly-once transcript handoff

Transcript handoff is operation/conversation metadata, not a renderer-only message. The persistent fork banner derives from this metadata.

The first accepted user turn includes the frozen bounded transcript preamble. The existing atomic user-turn acceptance boundary is extended so provider acceptance, canonical user-message persistence, handoff marker persistence and handoff-state clearing remain one transaction. A preparation or provider rejection leaves the handoff pending. A duplicate accepted origin returns the canonical completion without dispatching again. Restart before acceptance retains the banner and pending preamble; restart after acceptance does not replay it.

## Worktree and Git semantics

Worktree forks delegate to the existing `WorktreeCreationService`:

1. The fork coordinator reserves and freezes the conversation snapshot.
2. The Git adapter resolves the canonical repository from the source checkout, including when that checkout is itself a linked worktree.
3. The source checkout’s exact `HEAD` SHA becomes the materialization base.
4. The target lives under the canonical repository’s managed root, never beneath the source worktree.
5. The source status includes tracked and untracked changes and produces a stable receipt.
6. Dirty status returns `confirmation-required` before Git creation. Confirmation binds the exact HEAD and status digest; changed Git state requires a new confirmation.
7. `ForkWorktreeOwnerPort` receives the already-frozen fork stage. It does not reload history or resolve providers independently.
8. Its atomic owner commit inserts the operation result, canonical worktree, conversation/settings/lineage and rich messages together.

The UI says “Fork conversation into a new worktree from current HEAD.” Dirty confirmation states the exact commit and that uncommitted and untracked changes are not copied. The operation never stashes, commits, copies patches or mutates the source checkout.

Git failure before materialization leaves no fork. A clean exact worktree and created branch are compensated when later pre-command preparation/commit fails. Once setup, provider, terminal or user commands may have modified it, automatic deletion is forbidden. Dirty or identity-changed cleanup becomes `cleanup_required` with exact retained path/branch.

## Remote routing

`sourceConversationId` becomes a first-class routing key. Clients also supply the known source `machineId`; an explicit mismatch is rejected. Unknown remote ownership fails closed rather than falling back to local.

The source backend performs history, provider artifact, SQLite and Git work. Its authoritative result carries machine provenance. Desktop binds the returned conversation ID in `RoutingTable` before adding/activating the session. React Native and Android retain the connection/machine key in their route/coordinator state before navigation. Provider start, terminals, IDE, files, Git, archive and later forks therefore route to the same machine.

If the source disconnects after backend completion but before response delivery, reconnect queries the same machine and `requestId`, returning the existing serialized result.

## Client presentation

Desktop, React Native/iOS and native Android expose equivalent actions for forkable messages:

- “Fork conversation here”;
- “Fork conversation into a new worktree from current HEAD” when Git capability is available.

Each surface keeps the progress/error surface open after failure, retains the same `requestId` for Retry, handles dirty confirmation, and distinguishes anchor conflict, Git failure, provider artifact failure, persistence failure, cleanup-required and disconnected/unknown completion.

On success, clients consume the exact returned conversation/messages and hydrate project, worktree, branch, machine, provider/profile, model, mode, reasoning effort, resume mode and native hint before navigation. No synthetic cold-fork notice is inserted.

A compact persistent lineage banner shows parent title, anchor preview, native resume versus transcript handoff and optional branch/base SHA. Its parent action navigates to the exact source conversation and anchor. Mobile process restoration persists pending `requestId` and re-queries rather than minting another fork.

## Failure and compensation matrix

| Boundary | Result |
| --- | --- |
| Validation/anchor conflict before reservation | No operation side effect; typed conflict. |
| Reservation committed, no external side effect | Durable retry/cancel state; no fork. |
| Provider artifact written, database not committed | Remove exact Switchboard-created unconsumed artifact; report cleanup failure if removal fails. |
| Worktree created, owner not committed | Existing saga removes exact clean worktree and created branch plus artifact. |
| SQLite message/result insertion fails | Roll back conversation, messages, handoff and completed operation result together; compensate external resources. |
| Backend commits, response is lost | Same `requestId` returns serialized authoritative result. |
| Setup/provider/user command may have changed worktree | Retain and return `cleanup_required`; never auto-delete. |
| Cleanup identity mismatch or dirty worktree | Retain exact path/branch and require explicit recovery. |
| Source backend disconnects | Preserve request identity; query same machine after reconnect; never fail over locally. |

## Legacy diagnostics and repair

Add a read-only classifier with these outcomes:

- `healthy`;
- `legacy-project-path`;
- `missing-worktree`;
- `orphan-worktree`;
- `ambiguous-anchor`;
- `unusable-native-artifact`.

Startup never deletes or rewrites provider/worktree artifacts silently. An automatic database repair may restore a fork’s parent `project_path` only when parent lineage, matching worktree projection and canonical project evidence are unambiguous. Missing settings are reported and conservatively projected from proven source metadata. Orphan worktrees and `rollout-fork-*` artifacts are inventory only until explicit user confirmation authorizes cleanup.

## Compatibility and rollout

The shared contract is capability-gated as `conversation_fork_v1`.

- New client with old backend: hide/disable initiation with an update explanation; existing fork rows still load.
- Old client with new backend: the legacy channel must not retain unsafe positional authority. It returns an explicit update-required error rather than executing the old flow.
- New mobile with old backend: fork initiation is unavailable; reading ordinary conversations remains compatible.
- New backend with existing data: additive migrations and conservative diagnostics; no destructive startup repair.

No staged mobile flag is planned: Desktop, React Native/iOS and native Android initiation and metadata rendering ship together. Package identity, signing and update channels remain unchanged. Release notes describe provider resume truthfully and list unexercised hardware/provider combinations separately.

## Test strategy

Tests proceed strictly red-green-refactor.

- Pure anchor/digest tests cover stable IDs, stale digests, unique legacy fallback, repeated messages, provider markers, mixed segments, second-generation forks, attachment-only messages and non-forkable activity.
- Real in-memory SQLite tests run with foreign keys enabled and inject failures inside the complete fork transaction.
- Rich-message codec tests round-trip every durable attachment and verify returned IDs equal persisted IDs.
- Fork journal tests cover concurrent duplicate requests, changed-payload conflicts, frozen snapshots, response loss, process restart and atomic result visibility.
- Worktree tests use temporary Git repositories for canonical roots, nested source worktrees, exact base SHA, dirty tracked/untracked status, confirmation races, collision, compensation and cleanup-required receipts.
- Provider fixtures cover Claude profile/segment/native identity rewriting, explicit degradation, Codex discovery cleanliness, OpenCode handoff and first-turn acceptance.
- Routing tests prove source-machine dispatch, pre-activation result binding and same-machine response-loss recovery.
- Desktop, React Native and Android tests cover action eligibility, dirty confirmation, typed failures, authoritative hydration, lineage navigation and process restoration.
- Legacy diagnostics are evidence-only unless a repair is proven unambiguous.

Manual verification uses disposable Claude sessions under `~/.claude-tech-team` and `~/.claude-tejas`, plus available Codex/OpenCode profiles, clean/dirty/nested worktrees, restart, rich attachments and a remote machine. Automated, Desktop manual, remote, iOS hardware, Android hardware and unexercised evidence are reported separately.

If any E2E test runs, `$TMPDIR/sb-*` and `/tmp/sb-*` are removed after every pass, failure or crash as required by `AGENTS.md`.

## Cross-surface impact

1. **Desktop Electron:** affected across shared contract, IPC/preload routing, fork coordinator, persistence, provider artifacts, renderer actions/state, lineage UI and tests.
2. **React Native/iOS:** affected. Add typed client methods, message actions, dirty confirmation, durable retry/progress, authoritative navigation and lineage banner.
3. **Native Android:** affected. Add wire models/decoders, coordinator persistence across process death, long-press actions, confirmation/errors, authoritative navigation and lineage banner.
4. **Shared backend/API:** affected. Add versioned request/outcome/result, capability, coordinator, anchor/history provenance and provider resume planning.
5. **Stored data/migrations:** affected. Add fork operation journal, anchor/resume metadata, exhaustive message copying and conservative legacy diagnostics/repair.
6. **Update/release:** affected. Ship synchronized contract-capable clients/backend, publish release notes and run the complete release gate. No identity/signing/schema-channel changes.

The feature parity manifest is `docs/feature-parity/conversation-fork-reliability.json`.

## Invariants

- No raw renderer array index is authoritative.
- Ambiguous anchors fail; they never choose a plausible duplicate.
- One request ID produces at most one fork on its owning machine.
- Frozen preparation and completed operation result are durable across restart.
- Operation result and conversation/messages become visible in one SQLite transaction.
- Returned message IDs are the persisted fork IDs.
- Rich durable messages survive restart without silent attachment loss.
- `projectPath` is product ownership; `worktreePath ?? projectPath` is execution CWD.
- Source provider profile and machine ownership never silently migrate.
- Claude native resume is claimed only when actually compatible and verified.
- Codex and OpenCode remain explicit transcript handoff until real resume is proven.
- Worktree creation and rollback have one owner: `WorktreeCreationService`.
- Dirty source state is disclosed and never copied implicitly.
- Dirty or possibly user-modified cleanup targets are retained.
- Clients bind remote identity before activation.
- Fork lineage remains separate from provider session rotation lineage.
