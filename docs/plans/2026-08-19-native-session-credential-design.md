# Native Session Credential Persistence Design

## Goal

Persist a backend-minted device session without losing the active pairing credential, accepting stale handshakes, exposing secrets, or deleting legacy Expo SecureStore aliases.

## Compare-and-swap boundary

`WebSocketTarget` carries the opaque native credential reference that was resolved with its credential. The target does not print the reference. When pairing returns a minted session, `AuthenticatedWsCoordinator` passes that expected reference to `SessionCredentialStore`.

`ConnectionDatabase.compareAndSwapCredentialRef(connectionId, expectedOldRef, newRef)` is backed by one conditional Room update. A changed or deleted connection produces zero affected rows, so an older handshake cannot replace a newer credential or resurrect a removed machine. `NativeConnectionRepository` publishes a reread snapshot only after the conditional update succeeds.

## Rotation order

1. Fail closed if the expected reference is blank, missing, no longer active, or does not resolve to a native pairing/token credential.
2. Write and read back a fresh, unique `DEVICE_SESSION` value in native encrypted storage.
3. Atomically compare-and-swap the active Room reference.
4. On CAS failure, delete only the unreferenced fresh key and preserve the old active reference.
5. On success, publish the verified Room snapshot and return success.
6. Only after the coordinator accepts success, retire the old native-owned key. Failed cleanup leaves a harmless, non-authoritative orphan and never rolls back the active session.

`retireLegacyCredentials` only uses the native credential-store deletion API. It never addresses Expo SecureStore aliases and becomes an idempotent no-op after successful cleanup.

## Verification

Tests cover ordering, readback and database failures, stale replacement, concurrent removal, snapshot publication, cleanup retry/idempotence, missing expected references, and redacted diagnostic presentation.
