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
`thread_sessions` rows are retained as a compatibility source, then lazily
materialized into typed segments when provider evidence is available.

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

## Legacy Migration

Schema creation is additive. No conversation, message, or `thread_sessions`
row is deleted or rewritten.

On startup, lineage rows with unambiguous evidence are inserted into
`conversation_segments`. Evidence can come from a matching conversation row,
a provider session metadata record, or a current `session_id` plus provider
instance. Ambiguous rows stay in the legacy projection and remain loadable.

The existing `v0` shape is healed without a one-off data edit: its canonical
family loader reads the Claude child messages, follows the recorded Codex
session ID using the Lenskart instance's `CODEX_HOME`, and presents one merged
history.

## Forking

Fork history uses the same history module, so partially pruned conversations
do not silently lose their prefix. Provider-native resumability remains
provider-specific: Claude may assemble a resumable JSONL; Codex retains its
existing cold-fork behavior until native rollout rewriting is supported.

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

Targeted tests run after every red-green cycle. Completion requires the full
Vitest suite, TypeScript checks, the gated build, and an adversarial review of
the final diff.

## Recovery And Rollback

The existing recovery bundle remains untouched. The schema change is additive,
and legacy lineage remains authoritative as a fallback, so rolling back the app
does not require rolling back or rewriting user conversation data.
