# Codex missing-thread recovery

## Problem

When Codex app-server rejects `turn/start` because its native thread is no longer loaded, the adapter emits an error but resolves `sendTurn`. The registry therefore keeps the turn marked active and the renderer remains in “Working” indefinitely. A provider or credential-profile switch makes this more likely because native thread IDs are scoped to a Codex home and app-server process.

The reported screenshot was produced by a still-running Switchboard 0.8.20 process. That version also attempted `turn/start` with a prior Claude session UUID. Version 0.8.22 already resumes first and falls back to a fresh thread, but it still lacks terminal failure cleanup.

## Approaches considered

1. Only emit an idle status after failure. This fixes the spinner but makes the user resend and can repeatedly target the same stale thread.
2. Always create a fresh thread after any turn error. This risks duplicating a turn after ambiguous transport or server failures.
3. Retry once only for Codex's stable missing-thread errors, then reject any final failure and restore idle state. This is the selected approach because a missing thread proves the turn was not accepted while unrelated errors remain non-retriable.

## Design

The Codex adapter will isolate fresh-thread creation and turn submission into small internal operations. If `turn/start` rejects with `thread not found`, `no rollout found`, or `not loaded`, it will clear the stale native thread ID, start a new thread, and submit the same turn once. The retry is bounded to one attempt.

If either the initial non-recoverable attempt or the recovery attempt fails, the adapter will clear turn bookkeeping, emit `status: idle`, and reject `sendTurn`. The provider registry can then release its active-turn and deduplication state, while the sending client renders the failure once through its existing rejection handler.

## Testing

Adapter tests will first reproduce a stale native thread whose first `turn/start` returns a missing-thread error, then assert that a new `thread/start` and a successful second `turn/start` follow. A second test will assert that a non-recoverable error rejects and emits idle status. Targeted tests, typecheck, the full unit suite, build, code review, and deslop follow.
