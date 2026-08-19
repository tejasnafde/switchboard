# Android completed-update reconciliation

## Problem

After Android successfully replaces Switchboard, the persisted updater state can
remain `LaunchRequested`. On the next launch the controller restores that state
as `InstallerReady`, even though the target version is already installed. A
second install attempt is then rejected by the version preflight and shown as
the misleading error “APK identity changed after verification.”

## Design

Startup reconciliation will inspect the installed package before exposing the
persisted updater state. If a persisted verified artifact targets a version that
is already installed, startup will reset only the updater state to `UpToDate`
and discard the stale cached APK when safe. It will not clear application data,
the Room database, connection records, credentials, drafts, or conversations.

The installer preflight will retain its package, signer, and version safeguards,
but rejection messages will identify the actual mismatch. A version that is
already installed is a completed-update condition, not an identity-change
failure.

## Data flow

1. Read the installed production package identity.
2. Load the persisted update state.
3. Extract its verified artifact, if any.
4. Inspect the artifact identity when the file still exists.
5. If its package and signer match and its version code is no newer than the
   installed version, persist `UpToDate` before rendering updater UI.
6. Delete only that staged APK from the app-owned update cache.
7. Otherwise preserve the state and existing verification/install flow.

## Failure behavior

- Missing or unreadable cached artifacts fall back to a fresh update check.
- Package or signer mismatches remain hard failures and are never silently
  reconciled.
- Persistence or cache-cleanup failures are reported through the existing
  updater failure hooks without touching user data.

## Tests

- A completed 0.5.1 installation does not restore the 0.5.1 installer prompt.
- A genuinely newer verified artifact remains installable.
- Signer/package mismatches are not treated as completed updates.
- Installer preflight reports package, signer, version-code, and version-name
  failures precisely.
- The updater-state reset does not call any application-data or database API.
