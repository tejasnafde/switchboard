# Native Outbox Runtime Design

## Goal

Bridge the durable Room outbox to the authenticated native transport without changing the existing coordinator's FIFO, retry, ambiguity, or cleanup policy.

## Components

- `OutboxRemoteSender` resolves the current `SwitchboardRemoteClient`, materializes staged private attachments, invokes `sendTurn`, and maps its response to the existing `SendOutcome` model.
- `OutboxImageMaterializer` converts staged private files into `ImageInput` data URLs and recovers migrated image data URLs from the byte-exact legacy outbox JSON retained on `QueuedTurn`. It rejects malformed images, an image over 8 MiB decoded, or an aggregate wire payload over 12 MiB before any remote invocation.
- `OutboxRuntime` owns one application-lifetime `OutboxCoordinator`. It hydrates once after startup reaches ready and pumps when fleet readiness changes, a turn is enqueued, or the coordinator's injected retry scheduler fires.
- Injected client and fleet-capability lookups keep connection availability, transport generation, and `durable_turn_origin` support observable without binding the runtime to Android lifecycle classes.

## Delivery Classification

- Successful `CommandBody` values are decoded by `SendResponseDecoder`.
- Synchronous rejection for not-ready, capacity, or connection replacement is retryable because the command was not accepted for transport.
- Other synchronous rejection and every asynchronous remote failure are transport-ambiguous because bytes may have crossed the boundary.
- A response from a stale connection generation is transport-ambiguous.
- Invalid runtime modes and attachment materialization or size failures are permanent local failures.
- Room state transitions preserve `legacyRawJson`; acknowledged, retry, terminal, and ambiguous updates cannot erase a migrated image-only turn.
- Duplicate callbacks are ignored. Callbacks that fire before `sendTurn` returns are buffered until the `RequestSubmission` classification is known.

The existing coordinator decides whether a transport-ambiguous result is retryable. It retries only when the captured delivery gate advertised `durable_turn_origin`; legacy connections become visibly ambiguous and are never retried automatically.

## Verification

Pure tests cover response mapping, synchronous callback ordering, attachment limits, restart hydration, readiness transitions, stale generations, acknowledged-row cleanup failure, repeated wakeups, and absence of duplicate sends.
