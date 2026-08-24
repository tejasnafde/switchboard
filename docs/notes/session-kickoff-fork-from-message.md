# Conversation fork contract

This note replaces the original positional fork kickoff. The historical design
was unsafe and must not be used as implementation guidance.

## Canonical boundary

Clients send a stable message anchor containing the durable message ID, role,
timestamp, and SHA-256 digest of the complete structured message. The backend
loads one canonical ordered history snapshot, resolves the exact ID, validates
the fingerprint, and derives the prefix. Legacy fingerprint fallback is valid
only when exactly one message matches. Missing, stale, or ambiguous anchors
return `anchor-conflict`; a renderer index is never authoritative.

Parsed IDs are not uniformly regenerated. Claude UUIDs and Codex provider IDs
are retained when available. Renderer-only activity, notices, approvals, and
other non-transcript rows are not forkable.

## Backend-owned operation

`app:fork-conversation` accepts the versioned contract in
`src/shared/conversation-fork.ts`. A client-generated `requestId` makes retries
idempotent, while the backend generates the conversation ID, message IDs,
provider artifact, and any worktree path. The prepared source execution
profile, canonical transcript, native provenance, and Git receipt are frozen
before external side effects.

Conversation state, rich messages, pending exactly-once handoff state, lineage,
and the completed operation result commit in one SQLite transaction. The result
is queryable with `app:get-conversation-fork`, so response loss does not create a
second fork.

## Resume matrix

| Provider | Mode | Contract |
| --- | --- | --- |
| Claude | `native` when compatible | Assemble the exact native prefix in the source conversation's committed profile, rewrite session/root CWD metadata, and resume the new session ID. |
| Claude | `transcript-handoff` fallback | Used when the selected anchor lacks compatible native lineage or the committed profile is unavailable. |
| Codex | `transcript-handoff` | No fake rollout is written into provider discovery directories. The canonical transcript is injected once after the first user turn is accepted. |
| OpenCode | `transcript-handoff` | ACP has no verified compatible resume primitive; the same durable exactly-once handoff applies. |

The fork keeps the source conversation's currently committed provider,
credential profile, runtime mode, model, reasoning effort, machine, and launch
configuration. A mixed-provider anchor receives native resume only when its
lineage is compatible with that selected target provider.

## Durable lineage

Fork metadata stores the parent conversation, resolved anchor and preview,
resume mode, and Git receipt. Desktop, React Native/iOS, and native Android show
the same persistent status and navigate back to the exact parent anchor.
`thread_sessions` remains provider-session rotation lineage and is not used for
user-created fork ancestry.

## Verification

See `docs/plans/2026-08-24-conversation-fork-reliability-design.md`, the focused
`conversation-fork-*` tests, and
`docs/feature-parity/conversation-fork-reliability.json` for current evidence.
