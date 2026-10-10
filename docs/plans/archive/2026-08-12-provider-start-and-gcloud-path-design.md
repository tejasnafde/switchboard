# Provider startup and gcloud path hardening

## Problem

Two independent failures appear together in the v0.8.26 test session.

First, a second message can arrive while the first message is still starting its provider. The renderer currently records only that startup was requested, not that it finished. A rapid follow-up therefore skips `startSession` and calls `sendTurn` before the main-process adapter exists. Main rejects it with `No session`.

Second, an app launched from Finder inherits macOS's minimal executable path. The IAP transport spawns the bare command `gcloud`, while the user's executable lives in a login-shell path such as `/opt/homebrew/share/google-cloud-sdk/bin`. Provisioning therefore fails with `spawn gcloud ENOENT` even though the same command works in Terminal.

## Design

Provider startup becomes an awaitable operation keyed by conversation ID. Every renderer send awaits the same in-flight promise, and the main registry also waits for an in-progress start before resolving a concurrent start or send. The first turn remains first; later Codex messages continue through the existing mid-turn steering behavior after startup completes. Failed startup clears the shared state and returns the conversation to idle.

Machine processes receive a login-shell-aware environment. Executable discovery remains data-only: Switchboard probes the configured login shell for its environment, caches the result, and uses its `PATH` when spawning machine transport commands. It does not execute user aliases or interpolate machine data into a shell command. Ordinary SSH and Windows behavior remain unchanged.

## Tests

- A send that arrives during provider startup waits and reaches the registered adapter.
- Concurrent starts share one adapter startup and resolve only after registration.
- Startup failure remains retryable and does not leak a stuck active state.
- A packaged-style minimal process path can still spawn `gcloud` from the login-shell path.
- Existing plain SSH command construction and spawn behavior remain unchanged.

