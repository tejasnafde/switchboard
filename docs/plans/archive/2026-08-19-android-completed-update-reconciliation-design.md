# Android completed-update reconciliation

## Problem

After Android successfully replaces Switchboard, the persisted updater state can
remain `LaunchRequested`. On the next launch the controller restores that state
as `InstallerReady`, even though the target version is already installed. A
second install attempt is then rejected by the version preflight and shown as
the misleading error “APK identity changed after verification.”

## Design

Startup reconciliation will compare the release carried by the persisted
updater state with the app's current version before exposing that state. If the
release is already installed or older, startup will clear only the updater state
and begin one fresh discovery check. It will not clear application data, the
Room database, connection records, credentials, drafts, conversations, pending
installation tracking, or the app-owned APK cache.

The installer preflight will retain its package, signer, and version safeguards,
but rejection messages will identify the actual mismatch. A version that is
already installed is a completed-update condition, not an identity-change
failure.

## Data flow

1. Load the persisted update state inside `UpdateController`.
2. Extract its candidate release from every release-bearing update state.
3. Compare the candidate version with the current installed app version using
   the existing update version policy.
4. If the candidate is equal or older, clear `switchboard_update_state_v1` and
   restore `Idle` before rendering updater UI.
5. The normal controller startup then performs one fresh release discovery.
6. Otherwise preserve the state and existing resume/verification/install flow.

## Failure behavior

- Package or signer mismatches remain hard installer failures and are never
  silently reconciled.
- Failure to clear updater metadata is reported through the existing
  persistence-failure hook; startup still proceeds from a safe in-memory idle
  state without touching user data.

## Tests

- A completed 0.5.1 installation does not restore the 0.5.1 installer prompt.
- A genuinely newer verified artifact remains installable.
- A genuinely newer in-progress update still resumes from its saved state.
- Installer preflight reports package, signer, version-code, and version-name
  failures precisely.
- The updater-state reset does not call any application-data or database API.
