# Codex transient retry status

## Problem

Codex app-server emits `error` notifications with `willRetry: true` while it reconnects its response stream. Switchboard currently treats every notification as a terminal error, persists it, and appends a red system card. A successful five-attempt recovery therefore leaves five false errors in the transcript.

## Design

Represent a retry separately from a terminal provider error. The Codex adapter will emit a retry event containing the user-facing message and the native turn id. The registry will broadcast but never persist retry events.

The chat panel will keep at most one retry card per turn. Subsequent attempts update that card in place. The card is amber and temporary. A successful `turn.completed` removes it. A terminal Codex error removes the temporary card before the existing persisted red error is rendered, so the transcript records only the final outcome.

## Testing

- Adapter test: a Codex error notification with `willRetry: true` emits a retry event rather than an error event.
- Renderer reducer/helper tests: retry attempts for one turn share an id, and completion identifies the temporary card for removal.
- Existing terminal-error behavior remains unchanged.

## Scope

This changes only presentation and persistence of Codex's native retry notifications. Codex retains control of its retry timing and attempt budget; Switchboard does not add another retry layer.
