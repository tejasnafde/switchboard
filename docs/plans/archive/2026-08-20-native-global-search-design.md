# Native global conversation search

## Scope

Add message-body search to the native Android app without introducing a second
index or persisting new data. The desktop FTS database remains authoritative.
React Native only provides title filters today, so desktop global search is the
behavioral source for this slice.

## Contract

Keep `app:search-messages` and its existing single query argument. Extend each
result with canonical root-thread routing metadata: title, project path,
provider, worktree path, and worktree branch. Existing desktop clients ignore
the additive fields. The native decoder rejects malformed results rather than
guessing a route.

## Native behavior

A search coordinator owns a 200 ms debounce, a monotonically increasing request
token, connection-generation checks, and a bounded 40-row projection. Queries
shorter than two trimmed characters do not hit the network. Older responses are
ignored after the query or connection scope changes.

The Material screen uses the established Switchboard scaffold, search field,
list rows, progress treatment, and empty/error states. Selecting a result routes
directly to the canonical thread using metadata returned with that result.

## Verification

Tests cover the additive SQL result contract, exact remote decoding and wire
shape, result bounds and snippet normalization, debounce behavior, stale
response fencing, scope fencing, retry, and route construction. No device,
application launch, or E2E run is part of this slice.
