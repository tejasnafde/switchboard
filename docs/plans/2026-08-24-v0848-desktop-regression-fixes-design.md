# v0.8.48 Desktop regression fixes

**Date:** 2026-08-24
**Release target:** Desktop v0.8.48

## Problem

Desktop v0.8.47 exposes two regressions on macOS:

1. A blue inset focus border is shown around the only visible chat even though the indicator exists to distinguish two side-by-side chats.
2. A normal asynchronous quit can leave a windowless, already-drained process alive long enough for macOS reopen or a second launch to reactivate it. Recreating the window and backend during that transition can enter Electron/AppKit's reopen path and crash in `_handleAEReopen:`.

The user's installed v0.8.47 application and live database must remain untouched while the patch is built and verified.

## Design

### Chat focus indicator

Keep the focus border when two chat panels are simultaneously visible in split presentation. Do not expose the panel-level focused styling in single-chat or tabbed presentation; the selected tab already communicates focus in the latter. `ChatWorkspace` owns whether the presentation needs a pane indicator and passes that decision to `ChatPanel`. `ChatPanel` continues to update focused-slot state from pointer and focus events in every presentation.

This is preferred to removing the border globally because it remains useful in a real split, and to a CSS-only selector because the DOM's `data-focused` state should match the visible semantics.

### Quit and reopen lifecycle

`QuitCoordinator` becomes the authoritative source of whether teardown has started. Both ordinary quit and updater pre-drain enter that state. An ordinary quit still prevents the first `before-quit`, drains exactly once, then schedules exactly one retry of `app.quit()` on a fresh event-loop turn. Rejected or synchronously throwing teardown still permits exit.

The packaged second-instance path and macOS `activate` path must refuse to focus or recreate a window once teardown has started. This makes quitting one-way and prevents re-registering handlers against closed database, mobile, terminal, and provider services. Updater behavior is preserved: `prepare()` drains without scheduling the ordinary retry, then `quitAndInstall()` owns process replacement.

## Product impact

- **Desktop Electron:** renderer focus presentation and main-process app lifecycle change.
- **React Native/iOS:** not applicable; it has neither Electron activation nor desktop dual-pane rendering.
- **Native Android:** not applicable for the same reason.
- **Shared backend/API:** no message, IPC, or WebSocket contract changes.
- **Stored data/migrations:** no schema or data changes; direct v0.8.35 and v0.8.47 upgrades retain the existing migration path.
- **Update/release:** publish a new immutable desktop v0.8.48 release and verify its update metadata and packaged upgrade paths. No mobile runtime release is required for desktop-only code.

## Verification

Test-first regression coverage will prove that:

- the focus indicator is enabled only for a visible split;
- the first quit drains and prevents, repeated events do not duplicate teardown or retry, and the retry is deferred;
- lifecycle state suppresses activate and second-instance recreation during teardown;
- updater `prepare()` remains idempotent and does not schedule an ordinary quit retry.

Then run targeted tests, typecheck, the full root suite, feature-parity validation, the gated build/package smoke checks, and isolated packaged upgrade checks from v0.8.35 and v0.8.47. Packaged checks use temporary user data and never the live profile.
