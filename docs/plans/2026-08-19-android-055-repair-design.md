# Android 0.5.5 Repair Design

**Date:** 2026-08-19  
**Status:** Approved  
**Scope:** Cross-client image reliability and Google-account recovery presentation

## Outcome

Switchboard must treat an attachment-only turn as a real user message everywhere: optimistic Android state, live Android and desktop events, persisted history, and reload. Image validation must agree before the phone queues a turn, so unsupported or oversized files fail visibly without an ambiguous retry.

The Google account surfaces must distinguish signed out, blocked/unreadable credentials, and a failed legacy migration. The connections screen uses a standard account icon rather than a text fallback. The desktop OAuth setup uses the established button styling and must never overwrite a stored client secret when the field is blank.

No database reset, credential deletion, package rename, signer change, or update-channel change is allowed.

## Image data flow

The canonical visibility rule is: retain a user message when it has visible human text **or** at least one valid image. Synthetic prompt-only messages remain hidden unless they carry an image.

Desktop history merging must enrich a provider copy with images from the matching SQLite row rather than discarding the richer copy merely because role and text match. Codex history parsing must retain image-only input messages and reconstruct their data URLs. Live event reducers on both clients must preserve the same image list and stable `remote_<origin>` identity.

Android validates selected/staged images against the backend contract before durable enqueue: PNG, JPEG, WebP, or GIF data URLs; at most four images; and at most 3 MiB of synchronized encoded payload. A deterministic validation failure is terminal and actionable, not transport-ambiguous.

## Google account recovery

The app continues to read legacy Expo SecureStore keys without mutating them. UI state exposes the difference between no credentials and credentials that could not be prepared. Signed-out connections chrome uses a standard Material account icon.

Desktop OAuth configuration retains the existing behavior: client ID is required, the optional secret remains unchanged when blank, Cancel is non-mutating, and the controls use the project component styles instead of browser-default buttons.

The recovery path is explicit: configure the existing Desktop OAuth client on the Mac, complete Google consent there, then scan/import the credential on the phone. No production credential is bundled or guessed.

## Verification

- Failing tests first for attachment-only live and reload behavior on desktop and Android.
- Tests for rich-history merging and Codex image-only parsing.
- Tests for Android/backend MIME and size parity plus deterministic rejection classification.
- Compose tests for signed-out/blocked Google presentation and the account icon.
- Desktop component test for styled OAuth editor actions and blank-secret preservation.
- Full Android JVM/instrumentation/build gates and desktop typecheck/tests.
- Physical-phone smoke test using dummy screenshots, followed by an in-place production-signed upgrade from 0.5.4 to 0.5.5 with stored connection and database verification.
