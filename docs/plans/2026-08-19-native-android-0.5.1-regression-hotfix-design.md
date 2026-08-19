# Native Android 0.5.1 Regression Hotfix Design

## Problem

The first production native Android release introduced two launch-blocking
regressions relative to the React Native behavioral oracle.

The update surface renders a successful no-update result as a permanent bottom
card. That state is persisted, so a later cold launch restores the old result
without performing a fresh discovery check.

Direct WebSocket connections that use a device session or pairing credential
dial the saved URL without the backend's `auth=frame` marker. The desktop
listener therefore rejects the tokenless upgrade request with close code 4001
before it accepts the in-band credential. Android discards that close code and
treats the rejection as a retryable server disconnect, producing an endless
Connecting loop.

Live evidence rules out the Mac and Tailscale as causes: Switchboard listens on
`0.0.0.0:8765`, the tailnet address accepts TCP connections, and the desktop log
records `rejected connection with missing token` for the native client's
attempts immediately after the prior client connected successfully.

## Behavioral contract

Update discovery runs silently on cold launch. `Checking` and `UpToDate` have no
persistent global surface. A restored `UpToDate` result is treated as stale and
triggers a new background check. Available releases, download progress,
cancellation, installer permission, installer launch, and failures remain
visible and actionable.

Direct WebSocket URL construction depends on credential type:

- device sessions and pairing credentials remove embedded `token`, `pair`, and
  stale `auth` parameters, then set exactly one `auth=frame` parameter;
- legacy shared tokens remove embedded pairing/frame-auth parameters and set
  exactly one encoded `token` parameter;
- unrelated path, query parameters, and fragments are preserved.

WebSocket close code 4001 is an authentication rejection. It stops automatic
retry and surfaces the existing re-pair error. Other server/network closes keep
their existing retry policy.

Once a socket opens, authentication plus the ready handshake must complete
within a bounded interval. Silence during that interval becomes a terminal,
actionable handshake error instead of an unbounded Connecting state. A manual
Retry starts a fresh attempt. The watchdog is cancelled on Ready, close,
disconnect, replacement, and destruction, and stale callbacks cannot affect a
new generation.

## Implementation seams

`UpdatePresentation` owns visibility policy. `UpdateController.start` owns the
cold-launch refresh decision. The durable update state machine remains the
source of truth for actionable update operations.

`WebSocketUrlPolicy` owns credential-safe URL construction.
`OkHttpWebSocketDialer` owns the mapping from Android WebSocket callbacks and
close codes into protocol disconnect causes. `AuthenticatedWsCoordinator` owns
the handshake watchdog because it knows when the socket opens and when the
protocol reaches Ready. Fleet status maps authentication rejection and
handshake timeout to terminal user-facing errors.

## Verification

Test-first regressions cover:

- invisible Checking and UpToDate presentations;
- a persisted UpToDate state starting exactly one fresh discovery effect;
- framed-auth and legacy-token URL construction with preserved unrelated URL
  components;
- a real OkHttp WebSocket request carrying `auth=frame` for session/pairing;
- close code 4001 producing terminal authentication rejection with no redial;
- non-4001 closes retaining retry behavior;
- handshake silence timing out once, cancelling its socket, and ignoring stale
  watchdog callbacks after Ready or replacement.

Before publication, run the full Android unit/lint/build/androidTest-compile
gate and the repository gate. Publish version name `0.5.1` with a version code
greater than 2 through `mobile-release.yml`. The workflow must verify package
`app.switchboard.mobile`, the canonical production signer, monotonic version,
and checksum before creating `mobile-v0.5.1`.

Physical verification upgrades the installed 0.5.0 build without uninstalling,
confirms the update surface disappears after a no-update result, confirms the
stored Mac connects, and checks that existing data and credentials remain.
