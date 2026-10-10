# Native Google Account Integration Design

## Goal

Integrate the isolated Google Account screen with the native application while
keeping Google identity independent of per-machine connection navigation.

## Runtime ownership

`GoogleAccountRuntime` is owned by `NativeAndroidRuntime`. It shares the existing
`VerifiedGoogleCredentialStore`, application `OkHttpClient`, token exchange, and
revoke transport. `SwitchboardApplication` exposes this single instance;
`MainActivity` only observes state and passes callbacks into Compose.

The adapter exposes a `StateFlow<GoogleAccountPresentation>` plus suspend import
and sign-out operations. Callback-based coordinator results are bridged without
logging credential input. The adapter refreshes presentation after startup
migration and after every completed operation.

Bare refresh-token imports use the canonical public Android Google client ID
from `AppContract`. The fallback has no client secret.

## Navigation and UI

`AppRoute.GoogleAccount` is a serializable route. Connections exposes the same
account monogram affordance as the RN app. Pairing receives account readiness
and routes `onGoogleAccountRequired` to the same account screen once the
backend-owned Pairing seam lands.

Account state and callbacks flow as narrow parameters through
`MainActivity`, `SwitchboardApp`, and `SwitchboardNavigation`; they are not added
to `RootNavigationRuntime`.

The Google screen receives an explicit Back callback. QR remains a callback-only
boundary for this slice. Activating it shows fixed informational copy explaining
that scanning is unavailable in the native build and directing the user to paste
the desktop credential code. It is not presented as a transient failure.

## Lifecycle and concurrency

The application-owned adapter survives Activity and configuration recreation.
The existing import coordinator supersedes stale imports; the UI reducer also
fences completions by generation. Sign-out compare-and-clear cannot erase a
newer imported credential. Account presentation is always re-read from the
verified store after completion rather than inferred from transport success.

## Tests

Pure and JVM integration tests cover initial presentation, observable import and
sign-out refresh, bare-token fallback client identity without a secret, fixed QR
copy, account readiness, RN-compatible monograms, and Java serialization of the
new route. Existing Google UI reducer/presenter tests remain the screen behavior
contract.

Final verification runs focused JVM tests, production Kotlin compilation,
AndroidTest compilation, and diff checks. Physical-device testing remains
required for keychain behavior, real Google token/revoke calls, process death,
TalkBack, keyboard behavior, and eventual camera integration.
