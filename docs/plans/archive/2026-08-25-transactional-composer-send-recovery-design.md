# Transactional Composer Send Recovery

## Problem

Desktop currently keeps the submitted draft in the composer until the backend
returns its authoritative acceptance result. During a cold provider start, the
optimistic user bubble and working indicator can appear before that promise
resolves. The same message is therefore visible in both the transcript and the
composer for a short period, exposing an internal delivery guarantee as visual
duplication.

## Decision

Treat the composer as a transactional surface. On Send, snapshot the exact
composer state and clear the visible input immediately. Keep the optimistic
user bubble while delivery is pending. Acceptance commits the bubble and
discards the snapshot. Definite failure or ambiguous delivery removes the
optimistic bubble and restores the snapshot with actionable recovery UI.

The snapshot contains the text, pill metadata, image attachments, stable turn
origin, and a fingerprint of the submitted content. It remains renderer-only;
the backend atomic submission contract, persistence, and provider adapters do
not change.

## Data flow

1. Validate and prepare the outgoing message, attachments, handoff, and stable
   origin.
2. Snapshot the exact composer state.
3. Clear the composer synchronously and append the optimistic pending bubble.
4. Start the provider if needed and submit the prepared turn.
5. On acceptance, reconcile the canonical user event into the pending bubble
   and discard the snapshot.
6. On definite failure or ambiguity, remove the pending bubble and restore the
   snapshot when the composer has not acquired a newer draft.
7. If the user has already begun another draft, preserve it and show a recovery
   strip that can restore the failed snapshot explicitly.

## Retry semantics

An unchanged restored message exposes **Retry safely** and reuses the original
turn origin. Backend idempotency therefore prevents a duplicate turn even when
the first delivery was ambiguous.

Editing the restored payload changes the action back to **Send** and creates a
new turn origin. If the original delivery was ambiguous, Switchboard warns once
that the original may already have arrived before admitting the edited send.

## Errors and late events

- A definite startup or submission rejection restores the exact composer and
  displays the concrete error beneath it.
- Ambiguous delivery restores the composer with an amber notice and a safe
  retry action.
- A late canonical acceptance recreates or reconciles the accepted bubble. It
  clears the restored composer only when its content still matches the
  snapshot; edited or newer drafts remain untouched.
- Successful delivery leaves no recovery UI or temporary transcript artifact.
- Images, pills, and other composer metadata restore with the text.

## Cross-surface scope

1. **Desktop Electron:** composer lifecycle, renderer-only recovery state,
   optimistic bubble reconciliation, status copy, and tests change.
2. **React Native/iOS:** no behavior change; the client already uses a durable
   outbox and native pending/failed states.
3. **Native Android:** no behavior change; the client already uses its native
   outbox lifecycle.
4. **Shared backend/API:** no wire-format or atomic submission change.
5. **Stored data and upgrades:** no migration; recovery state is renderer-only.
6. **Release packaging and rollout:** Desktop patch release after all desktop,
   mobile, Android, packaging, and upgrade gates pass.

## Verification

Unit coverage will prove synchronous clearing, exact restoration, stable-origin
retry, edited-message origin rotation, newer-draft preservation, and late
acceptance. Real Electron coverage will exercise delayed cold startup,
optimistic feedback, rollback, retry, and successful reconciliation. Existing
desktop, iOS, Android, feature-parity, build, and upgrade gates remain required
before release.
