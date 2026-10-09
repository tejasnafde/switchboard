# Atomic user-turn submission

## Problem

Desktop currently renders and saves a user message before invoking the provider
submission handler. A definite invocation failure therefore leaves an ordinary
user row and bubble even though the provider never received the turn. The
August 22 incident with seven valid images is one example of that ordering bug.
The image count is not the admission rule. MIME validation and the existing
3 MiB aggregate data-URL budget remain unchanged.

The product invariant is:

> A user turn is not presented or stored as sent until the backend has durably
> accepted that exact origin and payload for provider dispatch.

## Considered approaches

### 1. Keep the positional call and remove the optimistic Desktop write

Desktop could wait for `sendTurn` and write the enriched row afterward. This is
small, but it leaves two writers, cannot atomically couple idempotency and the
complete row, and loses `displayBody`, pills, or handoff cleanup if the renderer
unmounts after provider acceptance. It also cannot classify an IPC timeout as
accepted, rejected, or ambiguous.

### 2. Add more positional metadata to `SEND_TURN`

Appending `displayBody`, `pillsMeta`, and handoff arguments would let the
backend write the row, but the wire is already version-sensitive and difficult
to validate as one payload. Older clients would also make the handler carry
several implicit call shapes.

### 3. Add a versioned typed submission envelope and retain a legacy adapter

This is the selected approach. New clients call `SUBMIT_TURN` with one
validated envelope. The backend normalizes older positional `SEND_TURN` calls
into the same coordinator where their fields permit it. The legacy channel
remains available throughout the mixed-version rollout.

New Desktop does not silently downgrade to an old remote backend that lacks
`SUBMIT_TURN`. The old backend cannot provide the invariant, so the safe
compatibility behavior is a definite, actionable rejection that leaves the
composer intact. Old phone builds continue to use positional `SEND_TURN`
against new backends.

## Contract

`UserTurnSubmissionV1` carries:

- `version: 1`
- `threadId`
- stable client `origin`
- `providerText`, including expanded pills and any handoff preamble
- optional `displayBody`
- optional validated `pillsMeta`
- optional validated images, including names used by transcript rendering
- optional runtime mode
- optional handoff metadata needed to clear the exact pending handoff and
  persist its marker only after acceptance
- optional first-turn title candidate

The payload hash covers every dispatch or committed-presentation field. The
thread, client scope, and origin form the idempotency key. Reusing the key with
a different provider text, image, runtime mode, display body, pill map, title,
or handoff metadata is a hard conflict.

The typed result distinguishes:

- `accepted`: committed, optionally a completed duplicate
- `pending`: the same origin is still reserved before dispatch
- `ambiguous`: provider dispatch may have occurred and must not be repeated
- `rejected`: the provider boundary was definitely not crossed
- `conflict`: the origin was reused with a different payload

## Backend state machine

The acceptance table is the durable inbox. Its forward-compatible migration
adds the canonical envelope and timestamps needed to recover or inspect a
submission. Normal transcript rows remain accepted rows only.

1. Validate the whole envelope and image budget without mutation.
2. In one transaction, reserve `(client scope, thread, origin, hash)` and store
   the canonical envelope.
3. Reject a new origin while an earlier origin for the thread is dispatching.
4. Complete all pre-dispatch preparation.
5. Atomically change `reserved` to `dispatching` immediately before calling the
   provider adapter.
6. If a `TurnNotAcceptedError` occurs, release the reservation. No transcript,
   title, activity, handoff, or event mutation remains.
7. If a generic error occurs after step 5, retain `dispatching`. Return
   `ambiguous`, preserve the envelope, and block later origins for that thread.
8. After adapter acceptance, commit the complete user message, mark acceptance
   `completed`, clear the matching handoff, persist its marker, generate the
   eligible first title, and bump conversation activity in one transaction.
9. Publish the canonical `user.message` after the transaction commits.

A completed duplicate does not call the provider. It reads or reconstructs the
canonical accepted event and republishes it, so a renderer that missed the
original acknowledgement can reconcile by origin.

An ambiguous acceptance record is not a normal transcript row and is not
indexed as sent content. History loading may surface it as an explicitly
unconfirmed delivery record, never as an ordinary user bubble.

## Client behavior

### Desktop

ChatInput owns a stable origin for the current exact composer payload.
ChatPanel caches the prepared envelope by origin so image conversion and
handoff text cannot drift across a retry. It validates before provider startup,
then submits without appending or saving a sent bubble.

Only an accepted result or canonical `user.message` echo clears the matching
composer payload. A definite rejection keeps text, pills, and `File`
attachments editable and restores idle status. An ambiguous result keeps the
same origin and payload, explains that delivery is unconfirmed, and never
mints a replacement origin automatically. The backend thread barrier prevents
a later `?` or any other new origin from passing the unresolved turn.

Activity and title updates follow accepted publication. Handoff markers and
`pending_handoff_from` are backend commit concerns, so renderer loss cannot
split them from the accepted turn.

### React Native and iOS

The durable outbox remains the only send path. It must decode the typed
acceptance result instead of treating every resolved RPC as success. It retains
attachments for rejected, pending, and ambiguous results, clears only after
accepted or canonical-origin reconciliation, and freezes the exact prepared
handoff wire payload for retries. Optimistic messages remain visibly queued,
not presented as accepted.

New mobile builds use the envelope capability when available and retain their
positional compatibility path for older backends. Installed older builds keep
working against the new backend channel adapter.

### Native Android

The Room outbox remains authoritative. The coordinator must keep a stable
origin, preserve private attachment files until accepted acknowledgement, map
typed pending and ambiguous results without deletion, and freeze any prepared
wire payload that participates in the origin hash. Existing capability-based
fallback remains for older backends.

## Cross-surface impact

1. Desktop Electron is affected through renderer, preload, main provider
   registry, state lifecycle, persistence, failure UI, and tests.
2. React Native and iOS are affected where result decoding, handoff payload
   stability, pending presentation, and attachment retention currently violate
   the contract.
3. Native Android changes only where behavioral tests identify an equivalent
   gap in its Room outbox or response decoder.
4. The shared backend/API is affected by the new envelope, result union,
   capability, coordinator, canonical event replay, and legacy adapter.
5. Stored data needs a forward-compatible acceptance-table migration. The
   ordinary messages schema does not need a delivery-state column because only
   completed submissions enter transcript storage.
6. Rollout supports old phone to new backend and new phone to old backend.
   New Desktop to old remote backend fails before submission with upgrade
   guidance because unsafe downgrade cannot satisfy the invariant.

## Verification

Behavioral tests exercise the real registered submission handler with a real
SQLite acceptance store and controlled adapter. They cover seven images below
the budget, aggregate rejection, startup rejection, definite pre-dispatch
release, post-boundary ambiguity, completed duplicate replay, payload conflict,
renderer loss and replay, pill and handoff metadata, and the thread barrier.

React Native tests exercise the actual outbox delivery interface, canonical
echo reconciliation, rejected attachment retention, and frozen handoff
payload. Android tests exercise its real outbox sender/coordinator, Room
records, private attachment lifecycle, and response classification.

Automated, Desktop manual seven-screenshot smoke, iOS hardware, Android
hardware, and unexercised checks are recorded separately in the feature parity
manifest. Compilation or unit tests are not described as hardware parity.
