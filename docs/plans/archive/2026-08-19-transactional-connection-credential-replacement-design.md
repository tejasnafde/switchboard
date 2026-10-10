# Transactional Connection Credential Replacement

## Goal

Replacing credentials for an existing native Android connection must never overwrite the active secret before the matching connection configuration is durably committed. A failed or stale edit must leave the prior configuration, native credential reference, and usable session intact.

## Transaction boundary

Each edit captures the complete stored connection row and its active native credential reference. A submitted replacement credential is written under a fresh native logical key and verified through encrypted-storage readback before Room is touched.

Room performs one transaction that compares both the complete expected connection row and expected native credential reference, writes the replacement connection row and reference, reads the resulting offline snapshot, and verifies both values. A mismatch returns a compare-and-swap conflict; an exception rolls back the transaction.

The repository publishes only the snapshot returned by the successful transaction. It never constructs or publishes an optimistic replacement state.

## Stale edit fencing

The repository assigns a monotonically increasing generation to each edit of a connection. The current generation is checked while holding the repository commit lock immediately before the Room CAS. A superseded edit cannot commit even if its credential write finishes later. A stale or CAS-losing edit deletes only the unique credential key it staged and returns a definite conflict error.

## Cleanup and ownership

After Room commits, the replacement is a success. The repository then attempts to delete only the prior native-owned credential through `deleteNativeOwned`. Cleanup failure does not roll back or report the committed replacement as failed; it records deferred cleanup through a non-secret observer seam and leaves a harmless orphan for a later retry.

Legacy Expo credential storage is outside the native credential store API and is never deleted by this flow.

## Failure behavior

- Invalid, blank, or reused staging keys fail before native storage changes.
- Encryption, preference commit, or decrypt/readback verification failure deletes only the staging key and leaves Room unchanged.
- A stale generation, Room CAS conflict, or Room exception deletes only the staging key and leaves the prior durable state untouched by that edit.
- Once Room CAS succeeds, the result remains success even if old native-key cleanup or telemetry fails.
- Error messages never include submitted credential material.

## Tests

Focused tests cover verified staging order, full-row/reference CAS, Room failure preservation, key collision rejection, interleaved edit generations, CAS losers, post-commit cleanup failure, snapshot publication, and the absence of legacy Expo deletion behavior. Production Kotlin compilation and focused unit tests are required before handoff.
