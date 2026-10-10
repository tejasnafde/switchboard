# Long Conversation Lineage Design

## Problem

Switchboard treats a conversation's current provider as if it described every
historical segment. That fails when a long conversation crosses Claude
compaction boundaries, changes provider, changes credential profile, or loses
part of its provider-owned JSONL history.

The observed `v0` failure combines those cases: a visible Claude conversation
continued in Codex, the Codex rollout lived in a non-default `CODEX_HOME`, and
the sidebar selected a synthetic root whose messages and provider metadata did
not represent the complete conversation. The data survived, but the loader
stopped at the last Claude turn.

## Invariants

1. A Switchboard conversation has one canonical ID and zero or more ordered
   provider segments.
2. A segment records its provider, provider session ID, provider instance, and
   creation order. Provider identity is never inferred from the conversation's
   current provider.
3. History loading merges every known provider segment with the SQLite mirror.
   A missing, truncated, or partially pruned JSONL cannot hide messages already
   persisted in SQLite.
4. Resume targets the newest compatible provider segment. A failed resume only
   falls back to a fresh thread for a confirmed missing-thread error.
5. Provider discovery reads structured JSONL metadata, compares project paths
   exactly, and searches every configured provider home.
6. Re-reading a provider transcript is idempotent. Parsed messages have stable
   IDs, so reloads do not duplicate SQLite or FTS rows.
7. Legacy `thread_sessions` lineage remains readable during migration and can
   be projected into typed segments without deleting source data.
8. A provider session discovered on disk is not necessarily a user-visible
   conversation or a history segment. Rotation, delegation, utility execution,
   and independent conversation are distinct relationships.
9. Sidebar visibility, direct openability, history membership, and resume
   eligibility are independent decisions. No single `hidden` flag controls all
   four.
10. Delegated and utility transcripts never enter a parent conversation's
    history, never become resume candidates, and remain recoverable through an
    explicit execution-inspector or direct-transcript path.
11. Missing provider evidence fails open for visibility: an unclassified legacy
    session remains independent and visible until stronger evidence or a manual
    decision says otherwise.
12. The provenance migration is additive. It does not delete, rekey, merge,
    archive, or rewrite conversations, messages, FTS rows, bookmarks, session
    layouts, fork lineage, kanban links, worktree pointers, provider JSONLs,
    `thread_sessions`, or `conversation_segments`.

## 2026-08-13 Provenance And Sidebar Amendment

> Superseded by the final upstream-aligned architecture decision at the end of
> this document. The evidence, failure fixtures, and safety constraints in this
> section remain useful, but the proposed always-on provider-session catalog is
> not the implementation plan.

The first implementation restored long mixed-provider history, but widening
Codex discovery to every configured `CODEX_HOME` exposed a second problem:
Switchboard's sidebar still equated every matching-cwd rollout with a logical
chat. Codex records root sessions, structured subagents, and `codex_exec`
utility runs beside one another. The affected project contains one foreground
Codex continuation, nine explicit subagents, and thirty-five utility/reviewer
runs. The recent `Codex 38`, `Codex 40`, and `Codex 45` rows are explicit
depth-one subagents of the same parent.

This amendment separates provider-session inventory from user-visible
conversation projection. It is a projection and provenance change, not a data
cleanup. Existing physical records remain addressable by their current IDs.

### Relationship Matrix

| Relationship | Normal sidebar | Directly openable | Parent history | Resume candidate |
| --- | --- | --- | --- | --- |
| Foreground provider segment | Canonical root only | Yes | Yes | Yes |
| Rotation or compaction | Canonical root only | Yes, through root alias | Yes | Yes |
| Provider transition | Canonical root only | Yes, through root alias | Yes | Newest compatible segment |
| Explicit subagent | Nested inspector only | Yes | No | No |
| Parentless utility execution | Auxiliary inspector | Yes | No | No |
| Independent interactive session | Top level | Yes | Own history | Yes |
| User fork or kanban chat | Top level | Yes | Own history | Yes |
| Unknown legacy session | Top level | Yes | Direct transcript only | Only after explicit open/promotion |

`parent_conversation_id` remains reserved for user-created fork lineage. It is
never overloaded for provider delegation.

## Domain Model

`conversation` is the user-visible logical chat. `conversation segment` is one
contiguous provider-owned context stream. `provider session ID` is the cursor
used by Claude or Codex to resume that segment. `SQLite mirror` is the durable
Switchboard-visible transcript and is not itself model context.

The new `conversation_segments` table contains:

- `id`: stable Switchboard segment ID.
- `conversation_id`: canonical root conversation.
- `provider`: `claude-code`, `codex`, or `opencode`.
- `provider_session_id`: Claude session UUID, Codex thread UUID, or ACP session
  ID.
- `provider_instance_id`: the credential/profile that owns the provider files.
- `ordinal`: monotonic order within the conversation.
- `created_at` and `updated_at`.

A uniqueness constraint on `(conversation_id, provider,
provider_session_id)` makes event replay idempotent. Existing
`thread_sessions` rows are retained as a compatibility source and projected at
read time. Proven live foreground events may continue to record typed segments,
but provenance backfill never materializes legacy rows into
`conversation_segments`.

`conversation_segments` contains foreground context only. Provider subagents,
review subprocesses, and other auxiliary executions are not segments even when
they share a cwd or name a foreground provider session as their parent.

The provenance amendment adds three tables:

### `provider_session_observations`

Provider facts are stored separately from their resolved verdict so conflicting
evidence remains auditable instead of being flattened into an impossible row.

- `provider`, `provider_session_id`, `observation_kind`, and `source_key` form
  the identity.
- `parent_provider_session_id`, `canonical_conversation_id`, `project_path`,
  `provider_instance_id`, `metadata_json`, `evidence`, and `observed_at` record
  the bounded fact supplied by one source.
- Evidence is append-or-upsert by `source_key`; a stronger observation does not
  delete a weaker conflicting one.

### `provider_sessions`

- `provider` and `provider_session_id`: composite native identity.
- `relationship_kind`: resolved `segment`, `rotation`, `subagent`, `utility`,
  `legacy_alias`, `independent`, or `unknown`.
- `parent_provider_session_id`: nullable explicit provider parent.
- `canonical_conversation_id`: nullable proven logical owner.
- `project_path`: normalized provider cwd/project association used by indexed
  projection joins; provider metadata retains the original cwd separately.
- `resolution_evidence` and `resolution_rank`: the winning automatic evidence.
- `has_conflict`: whether incompatible observations require inspection.
- `metadata_json`: bounded provider-specific facts needed by the inspector;
  never a transcript body.
- `discovered_at` and `updated_at`.

The primary key is `(provider, provider_session_id)`. Automatic discovery
recomputes this resolved row idempotently and may only replace a verdict with
stronger evidence. Indexes on normalized `project_path`, relationship kind, and
canonical owner support projection without decoding `metadata_json` or opening
provider files.

Visibility, history membership, and resume eligibility are derived predicates,
not independently writable columns:

- `segment` and `rotation` require a canonical owner and contribute history;
- `subagent` requires an explicit parent, is nested, and contributes no history;
- unowned `utility` is project-level auxiliary and contributes no history;
- `legacy_alias` requires a canonical owner and follows that owner's foreground
  role only when positive lineage evidence exists;
- `independent` is primary and contributes only to its own direct transcript;
- `unknown` is primary/direct-openable but joins no other root and is not
  resumable until explicit user intent records `independent`.

Database CHECK constraints reject invalid resolved combinations, including a
subagent marked primary/history-contributing, a rotation without an owner, or
an independent session with a parent. Resolution validates parent cycles and
that a canonical owner belongs to the same project unless an explicit
worktree/root relationship permits it.

Ownership evidence and execution role are evaluated separately. A structured
native `subagent` or `utility` role is a hard negative for history and resume,
even if stale foreground lineage also names that provider session. Conflicting
owner evidence never turns a delegated role into a segment; it records a
conflict for inspection. A manual Promote/Mark-independent decision can change
the role deliberately.

### `provider_session_copies`

- `provider`, `provider_session_id`, and `file_path`: composite identity.
- `provider_instance_id`: nullable credential/profile owner.
- `size`, `mtime_ms`, and `inode`: scan-validation tuple.
- `last_seen_at`.

This separates one native provider session from duplicate physical copies in
several provider homes. Copy selection and transcript completeness remain
history-module concerns, not sidebar identity.

An identical rescan does not update `last_seen_at`; the timestamp advances only
when the validation tuple changes or a previously missing copy reappears. This
keeps strict second-run idempotence observable while retaining useful liveness
information.

### `provider_session_overrides`

- `provider` and `provider_session_id`: composite native identity.
- `decision`: `promote`, `nest`, `auxiliary`, `independent`, or `detach`.
- `canonical_conversation_id`: nullable explicit owner.
- `created_at` and `updated_at`.

Manual overrides live separately so automatic rescans cannot overwrite them.
An override always outranks inferred provenance.

## Module And Seams

The deep module is `conversation-history`. Its small interface is responsible
for the complexity currently spread across IPC handlers, scanners, forking,
and adapters:

- `loadConversationHistory(conversationId, options)` returns an ordered,
  deduplicated transcript and diagnostics about missing segments.
- `resolveResumeSegment(conversationId, provider, instanceId?)` returns the
  newest compatible provider cursor.
- `recordConversationSegment(input)` idempotently records provider lineage.

Provider adapters remain responsible for speaking their native protocols.
Provider transcript readers are internal adapters at the history seam. The
renderer only knows the canonical conversation ID and never chooses a provider
session ID itself.

The provenance amendment adds a second deep module,
`conversation-projection`, with one external interface:

- `visibleConversationRoots(projectPaths)` returns canonical logical roots,
  ordered for presentation, plus optional aggregate execution counts.

The module owns provider inventory joins, provenance precedence, archive
filtering, canonical identity, DB-only roots, title/worktree projection, and
deduplication. Callers never merge or filter raw scanner results. A batched
interface avoids repeating the provider-home walk once per project.

Only this module may emit the `SessionSummary` values used by sidebar-like
surfaces. The following paths must call it:

- `GET_PROJECTS`;
- `SCAN_SESSIONS`;
- mobile `GET_CONVERSATIONS`;
- remote `ADD_PROJECT_PATH`;
- native `OPEN_FOLDER`;
- remote snapshot refresh and recents, through `GET_PROJECTS`.

A source-contract test permits `scanAllSessions` imports only inside provider
inventory/projection code. This prevents the duplicated visibility algorithms
that previously made desktop and mobile address the same chat by different
IDs.

The existing `conversation-history` interface remains responsible for history
and resume. Both `loadConversationHistory` and `resolveResumeSegment` apply a
defensive `historyRole(provider, sessionId, canonicalRoot)` predicate. Existing
legacy family IDs with no catalog row retain their old behavior for backward
compatibility. A cataloged `unknown` may supply its own direct transcript but
does not join another root. An explicit native subagent/utility verdict excludes
a session even if stale or mistaken foreground lineage also names it. This
read-time defense prevents one bad write from resuming a subagent.

The module also exposes internal identity resolution used by navigation and
settings:

- `resolveConversationRef(ref)` returns `canonical-root`, `native-execution`,
  or `missing` plus the physical message memberships and provider cursor.
- `resolveMessageTarget(physicalConversationId, messageId?, timestamp?)`
  returns the target surface, canonical/native ID, and best scroll anchor.

These are internal seams behind IPC; renderer callers do not reproduce alias
logic.

## Canonical Root Materialization

Persisted `conversations` rows keep their existing IDs. An inventory-only
native session uses a deterministic namespaced reference
`native:<provider>:<provider-session-id>` in projection, preventing cross-
provider collisions. It is not a resumable logical root merely because it was
discovered.

On first explicit open of an independent/unknown native reference, one
transaction:

1. creates a `conversations` row using that deterministic namespaced ID if no
   compatible physical row already exists;
2. records a manual `independent` override (explicit user intent);
3. records the native session as its foreground provider segment;
4. records any existing raw-ID conversation row as a foreground physical alias
   without rekeying its messages;
5. returns the canonical namespaced/root ID and native resume cursor separately.

Opening a delegated or utility reference does not materialize a resumable
conversation; it opens the execution inspector. Promote performs the explicit
materialization transaction. The transaction is idempotent, validates provider,
project, and native identity, and never silently changes an existing root.

Native provider session IDs are treated as globally unique within one provider;
duplicate copies across instances must agree on provider metadata identity.
Conflicting copies are marked ambiguous rather than merged. The provider name
is always part of catalog and virtual-reference identity.

## Physical Message Membership

Canonical history cannot rely only on `thread_sessions`. A generic membership
query returns physical conversation rows whose messages belong to a root:

- the canonical conversation row;
- compatible legacy `thread_sessions` family rows;
- physical rows whose `id` or `session_id` matches a positively owned
  foreground provider session;
- explicit foreground aliases recorded during materialization.

Delegated, utility, unknown, and conflicting rows are excluded. The same
membership set drives SQLite messages, display-body enrichment, read state,
search alias resolution, export, and fork selection. Disk transcript location
remains a separate provider-copy lookup.

## Loading Flow

1. Resolve the canonical root and collect typed segments plus compatible
   legacy lineage.
2. Locate Claude transcripts across configured Claude homes and Codex rollouts
   across configured `CODEX_HOME` directories.
3. Parse each segment with deterministic message IDs.
4. Read SQLite messages for every conversation row in the lineage family.
5. Merge disk and SQLite records chronologically. Prefer the richer disk
   representation for the same stable ID; retain SQLite-only records.
6. Add Switchboard-only system markers and apply the requested tail limit.

Partial availability is a normal result, not an all-or-nothing fallback.
Diagnostics are logged per missing segment without discarding surviving data.

Delegated and utility transcripts are intentionally absent from this flow.
Their result already returned to the foreground agent is part of the parent
history; their private working transcript is not. Direct execution inspection
first loads a cataloged copy by native identity/file path. If provider files
were pruned, it falls back to messages stored under the execution's physical
conversation row. It never routes through the parent's
`loadConversationHistory` or changes the parent's resume cursor.

## Discovery And Resume

Codex discovery parses the first `session_meta` record and uses
`payload.id` as the provider session ID. It compares normalized `payload.cwd`
to the requested project path rather than substring matching. Discovery accepts
all configured Codex homes, matching the existing multi-instance provider
model.

Resume reads the newest typed segment for the selected provider and instance.
Adapters must distinguish a provider-confirmed missing thread from transient
initialization, authentication, and transport failures. Only the former may
start a fresh provider segment automatically.

Codex provenance is read from the immutable first `session_meta` line using the
same bounded, promise-cached metadata read as cwd discovery. Structured
`source.subagent.thread_spawn` supplies an explicit parent, depth, path, and
nickname. `originator=codex_exec` or `source=exec` classifies a run as utility,
but does not prove a canonical parent.

Claude top-level legacy provenance is weaker. Nested SDK-managed `subagents/`
directories remain outside the top-level scanner. A top-level Claude JSONL is
collapsed only when live launch-time ownership, `conversation_segments`,
`thread_sessions`, or explicit native linkage proves the relationship. Cwd,
title, and timestamp proximity are never ownership evidence. No evidence means
independent and visible.

The normal projection never parses a full JSONL. Richer classification, if
introduced later, runs outside the request path and persists a verdict keyed by
path, size, mtime, and inode. Until that pass completes, unknown sessions remain
visible. This preserves the bounded metadata discipline introduced after the
pre-v0.5.3 scanner OOM.

At live provider start, the registry records foreground ownership
transactionally because it knows the Switchboard thread, provider, instance,
and native session ID. Provider-internal subagent creation never passes through
that foreground event path as a new logical conversation.

## Legacy Migration

Schema creation is additive. No conversation, message, or `thread_sessions`
row is deleted or rewritten.

At read time, lineage rows with unambiguous foreground evidence participate in
the same history projection as typed segments. Evidence can come from existing
`thread_sessions`, a matching conversation row, or a current `session_id` plus
provider instance. Ambiguous rows stay in the legacy projection and remain
loadable. Startup migration does not write inferred legacy rows into
`conversation_segments`.

The existing `v0` shape is healed without a one-off data edit: its canonical
family loader reads the Claude child messages, follows the recorded Codex
session ID using the Lenskart instance's `CODEX_HOME`, and presents one merged
history.

The provenance backfill is separate from the foreground-lineage migration. It
automatically writes only `provider_sessions` and `provider_session_copies`.
`provider_session_overrides` is created by schema migration but written only by
explicit user actions. Backfill does not add, remove, or change
`thread_sessions`, `conversation_segments`, `conversations.session_id`, or
`conversations.archived`.

Evidence precedence is:

1. manual override;
2. typed `conversation_segments` foreground ownership;
3. existing `thread_sessions` rotation ownership;
4. explicit structured provider parent metadata;
5. deterministic filename/native-ID alias;
6. utility classification without ownership;
7. independent visible fallback.

This precedence chooses ownership and visibility metadata; it does not override
the hard role rule. Structured `subagent`/`utility` classification excludes a
native session from history and resume. A conflict between that role and stale
typed/legacy lineage is logged and remains non-resumable until a manual
override resolves it.

Automatic backfill is transactional, idempotent, and evidence-monotonic. A
second run produces no row-count, verdict, or timestamp changes unless provider
metadata changed or stronger evidence appeared. Conflicting parents, cycles,
and malformed metadata resolve to independent/ambiguous rather than choosing a
newest copy.

Previously clicked or renamed scanner entries may already have conversation
rows. A DB row alone is not proof of user intent. DB-only synthesis joins the
same provenance catalog and canonical projection, so filtering a JSONL cannot
resurrect its physical conversation twin. Conversely, explicit promotion makes
that row a durable primary root even if its JSONL is later pruned.

Search and bookmark storage retain physical conversation/session IDs. On
navigation:

- a foreground alias resolves to its canonical root and message;
- a delegated/utility hit opens the execution inspector/direct transcript;
- an independent/promoted hit opens its own conversation;
- no bookmark row is rewritten during migration, avoiding uniqueness
  collisions on `(session_id, message_timestamp)`.

Canonical open resolution always returns the canonical logical ID, whether or
not that session is already live in the renderer store. After a fresh restart,
opening a foreground alias creates/activates only the root renderer session and
passes the provider cursor from backend resume resolution; it never creates a
twin keyed by the alias. Execution-inspector navigation retains the physical
execution ID because it is intentionally not a resumable logical root.

Archive remains a user action on logical conversations. Internal visibility
never writes `archived`, and hidden executions do not appear in the ordinary
archive list. The canonical root's archive bit governs whether the primary row
is visible. An archived or unarchived auxiliary/child bit neither hides the
root nor leaks the child into the ordinary archive list. Every physical archive
bit is preserved exactly for rollback and direct inspection.

## Forking

Fork history uses the same history module, so partially pruned conversations
do not silently lose their prefix. Provider-native resumability remains
provider-specific: Claude may assemble a resumable JSONL; Codex retains its
existing cold-fork behavior until native rollout rewriting is supported.

Only primary/promoted logical conversations are forkable. Native truncation and
resume selection use foreground segments after applying the history predicate;
a delegated execution can never furnish the JSONL or cursor for a parent fork.

Kanban-linked chats, user-created forks, and worktree chats are explicit roots
before a provider JSONL exists. The projection keeps them visible immediately
and treats worktree paths as execution cwd, not as evidence that nearby native
sessions share identity.

## User Experience

The normal sidebar shows one row per logical conversation. A mixed-provider
root may show a subordinate summary such as `Claude -> Codex · 44 agent runs`.
Expanding it reveals an `Agent Runs` disclosure with separate Subagents and
Review/exec groups. Nested entries are visually subordinate and never behave as
resume targets or top-level chats.

The inspector ships with promote/unhide support, not as a later recovery
afterthought:

- **Promote to conversation** makes an execution an independent primary root.
- **Nest under conversation** records explicit non-history ownership.
- **Mark independent** prevents future automatic nesting.
- **Detach automatic relation** stores a tombstone/manual override so rescans
  cannot recreate it.

The first production slice may keep the inspector minimal, but must provide at
least a recovery list and Promote/Unhide before automatic hiding is enabled.

## Tests

Tests are added before implementation and must fail for the intended reason:

- Claude-to-Codex transition loads both segments under one canonical chat.
- SQLite-only messages survive when one of several JSONLs is missing.
- Codex rollout filename prefixes do not become thread IDs.
- Project paths use exact metadata matching.
- Non-default `CODEX_HOME` rollouts are discovered.
- Codex message IDs remain stable across repeated parses.
- Resume selects the newest compatible segment.
- Transient resume failures do not silently create a fresh thread.
- Fork loading merges surviving disk segments with SQLite history.
- Legacy lineage remains visible after additive migration.

The provenance amendment adds these test groups:

### Provider metadata

- Codex root, structured depth-one/depth-N subagent, `codex_exec`, malformed
  metadata, oversize first line, and duplicate copies.
- Claude live foreground evidence, existing rotations, top-level unknown
  session, and exclusion of nested `subagents/` directories.
- Unknown or conflicting evidence remains independent and visible.

### Canonical projection

- One root plus rotations, Claude-to-Codex foreground segments, subagents, and
  utility runs produces one primary row.
- A persisted DB row for a hidden execution does not resurrect it.
- Pruning every root JSONL still leaves the canonical DB conversation visible.
- Independent same-cwd sessions, forks, kanban roots, worktree chats, and
  manually promoted imports remain visible.
- Duplicate homes and physical copies produce one native identity.
- Title, activity time, provider label, archive state, and worktree pointer are
  projected from the canonical root.

### Consumer parity

- `GET_PROJECTS`, `SCAN_SESSIONS`, `GET_CONVERSATIONS`, `ADD_PROJECT_PATH`, and
  `OPEN_FOLDER` return the same canonical IDs and visibility.
- Remote snapshot refresh removes legacy polluted rows; recents count roots.
- A source-contract test rejects new direct `scanAllSessions` consumers.

### History, resume, and fork safety

- Foreground segments merge and the newest compatible segment resumes.
- Explicit `contributes_history = false` excludes a session from history and
  resume even if stale lineage references it.
- Delegated transcript messages never appear in parent history.
- Parent forks use only foreground native material.

### Navigation and preservation

- Foreground search/bookmark aliases open the canonical root at the message.
- Delegated search/bookmark hits open the execution transcript, not the parent.
- After a fresh restart with no live renderer session, a foreground alias still
  creates only the canonical root and never seeds `resumeSessionId` from the
  alias.
- Archive/unarchive operates once per logical root and does not surface hidden
  executions in the ordinary archive list.
- Existing messages, FTS rows, bookmarks, layouts, forks, kanban links,
  worktrees, and raw provider files remain unchanged.

### Migration and rollback

- A fixture matching the affected `v0` shape includes the synthetic
  `agent_1786000350667` root, the titled Claude `v0` row with 516 messages,
  four existing `thread_sessions` children, a typed Codex segment in a
  non-default `CODEX_HOME`, nine structured subagents, thirty-five
  `codex_exec` runs, clicked worker conversation rows, rollout-stem aliases,
  and mixed physical archive bits. It produces one canonical `v0` row,
  preserves the exact merged foreground history, and leaves every legacy table
  byte-for-byte unchanged.
- Backfill run two is a no-op, including timestamps.
- Manual overrides survive repeated discovery.
- Snapshot tests prove `conversations`, `messages`, FTS, `thread_sessions`, and
  `conversation_segments` contents do not change during provenance backfill.
- Disabling the projection restores legacy visibility without data loss.
- Classified, hidden, ambiguous, and promoted counts are logged.

### Performance

- Projection performs indexed DB joins without opening JSONLs.
- Codex first-line metadata is read once per file/copy validation tuple.
- N projects do not trigger N full provider-home traversals.
- Unknown sessions remain visible while any asynchronous classification is
  pending.

Targeted tests run after every red-green cycle. Completion requires the full
Vitest suite, TypeScript checks, the gated build, and an adversarial review of
the final diff.

## Recovery And Rollback

The existing recovery bundle remains untouched. The schema change is additive,
and legacy lineage remains authoritative as a fallback, so rolling back the app
does not require rolling back or rewriting user conversation data.

A projection feature flag/kill switch selects the legacy list algorithm without
changing catalog data. Because provenance backfill never writes the legacy
identity, lineage, archive, or transcript tables, the switch restores the exact
pre-feature visibility semantics. Removing an automatic catalog verdict or
adding a manual override restores one misclassified session immediately.

Each backfill logs totals for discovered copies, native identities, primary
roots, nested executions, auxiliary executions, ambiguous sessions, manual
overrides, and conflicts. Unexpected count changes are diagnosable before a user
needs to inspect SQLite manually.

## 2026-08-13 Final Upstream-Aligned Architecture Decision

Reviewing T3 Code at `df19f6cfe3046dbbeb4073a3aac4c12f991b8fc7` and
Omnigent at `321a766e59ccfc45771498aba99d2251918fbaa6` changed the
implementation direction. Both systems create a logical conversation before a
provider starts, derive their normal sidebar exclusively from app-owned rows,
and keep provider-native session IDs below that identity. Provider transcript
scans are observability or explicit-import inputs, never sidebar roots.

Switchboard will use the same shape while retaining ordered typed segments,
which neither upstream system supports across a Claude-to-Codex transition.

### Authoritative Model

1. `conversations` owns every user-visible logical chat. Normal sidebar queries
   return canonical root conversations only.
2. `conversation_segments` owns the ordered foreground Claude, Codex, and
   OpenCode execution chain beneath a conversation. Native session IDs are
   resume cursors, not conversation IDs.
3. Delegated executions are durable child runs linked to a canonical root and,
   when known, a direct parent run. They never become normal sidebar roots,
   history segments, or resume candidates.
4. Completed and interrupted-visible output is normalized into SQLite before it
   is considered durable UI history. Provider JSONL is a resumable cache and
   recovery source, not the UI database.
5. Native filesystem discovery is available through an explicit
   Import/Recovery surface. Import deterministically creates or attaches a
   managed conversation only after a user chooses it.

### Sidebar And Child-Agent UX

The sidebar reads managed roots from SQLite without merging scanner output.
Subagents appear in a parent-scoped Agents panel/tree with status, provider,
role, timing, usage, and transcript availability. A child remains directly
inspectable. Promoting a child creates a new root/fork; it does not mutate the
original lineage.

Codex `source.subAgent.thread_spawn` is authoritative child evidence. A
structured child is mapped idempotently to one child run. Provider rotation,
compaction, and explicit `/clear` or `/new` are handled separately and can never
be inferred merely because a new JSONL appeared.

### Legacy And Recovery Policy

Existing managed conversations remain roots. Existing typed segments and
`thread_sessions` continue to load without destructive rewrites. The repair for
v0.8.29 classifies only strong structured child evidence automatically; it
removes those rows from the normal root projection while preserving their
messages and direct-open path. Ambiguous historical sessions remain available
in Import/Recovery and are never silently merged, deleted, or resumed.

When native resume material is missing, Switchboard preserves the durable
visible history and records an explicit cold-continuation boundary. Native-file
reconstruction from durable messages is a supported follow-up, modeled after
Omnigent, but is not required to make the sidebar and history correct.

### Minimal Schema Direction

- Keep `conversations` and `conversation_segments` as the canonical root and
  foreground-segment tables.
- Add a focused child-run table keyed by provider-native child identity, with
  root conversation, optional parent run, provenance, lifecycle, and transcript
  pointer fields.
- Add only the lineage columns required to exclude strongly classified legacy
  children from root queries without rekeying dependent data.
- Do not add the superseded general-purpose `provider_sessions`, copy catalog,
  automatic override, or multi-stage projection subsystem to the normal read
  path.

### Test And Release Gate

Tests must prove that one managed root plus foreground rotations, provider
transitions, structured subagents, utility executions, malformed metadata, and
missing JSONLs yields exactly one sidebar chat with complete foreground history.
They must also prove direct child inspection, import idempotency, archive/search
isolation, stable FTS/bookmark/layout/kanban references, and conservative legacy
repair against the backed-up `v0` fixture. The release requires targeted
red-green cycles, the complete test suite, typecheck, gated build/smoke test, and
an adversarial Claude review of the final diff.
