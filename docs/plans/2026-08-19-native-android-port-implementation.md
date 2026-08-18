# Switchboard Native Android Port Implementation Plan

This plan implements the approved design in vertical slices. Every slice must
leave `apps/android` buildable and must add its tests before production code.
The React Native app remains the behavioral oracle and iOS client.

## Global gates

For every slice:

1. Add a failing JVM, instrumented, or contract test.
2. Implement the smallest behavior that passes it.
3. Run focused Android tests.
4. Run `./gradlew testDebugUnitTest lintDebug assembleDebug`.
5. Run affected root protocol/server tests.
6. Record hardware-only acceptance items without claiming they ran.

Before any public release additionally run instrumentation, release assembly,
APK inspection, signer verification, checksum verification, and the physical
production-signed upgrade matrix.

## Slice 0: Toolchain and canonical scaffold

Create `apps/android` with a checked-in Gradle wrapper, version catalog, one
Compose application module, Java/Kotlin 17, min SDK 24, target/compile SDK 36,
and namespaces under `app.switchboard.mobile`.

Release identity:

- release application ID `app.switchboard.mobile`;
- debug suffix `.native.dev`;
- version name `0.5.0` and version code `2`;
- app label, portrait orientation, dark edge-to-edge theme;
- both existing URI schemes;
- camera, microphone, notifications, network, cleartext and installer
  permissions;
- existing Firebase configuration and notification channel ID;
- canonical icon and font assets copied byte-for-byte.

Add JVM tests for version comparison, release selection and update presentation.
Add CI that builds unsigned debug/release artifacts without changing the public
release workflow. Document the EAS-keystore export as a stop-ship prerequisite.

Acceptance: debug APK assembles, package metadata tests pass, and RN files remain
untouched.

## Slice 1: Updater state machine

Implement GitHub `mobile-v*` discovery, progress, cancellation, `.part`
staging, digest verification, archive metadata/signature preflight,
unknown-source recovery, FileProvider handoff, process recreation and next-boot
installation confirmation.

Use interfaces for release API, downloader, archive inspector and installer so
the complete decision state machine is JVM-tested. Instrument FileProvider and
installer intents.

Acceptance: every discovery/error/cancel/retry/permission state is visible in a
minimal Compose shell and repeated taps cannot start duplicate work.

## Slice 2: Legacy migration and native storage

Add checked-in fixtures representing both AsyncStorage schemas, Zustand
wrappers, raw outbox rows and Expo SecureStore AES-GCM records. Implement a
read-only inventory/decoder and a Room schema for:

- connections and encrypted credential references;
- preferences and drafts;
- thread/feed cache;
- outbox and private attachment files;
- per-connection replay cursor/epoch;
- pending control actions;
- migration reports and quarantined records.

Migration writes one transaction, verifies content, then marks completion. It
never deletes legacy files. Instrument process death/retry, malformed records,
keystore failure and offline-first launch.

Acceptance: installing over a seeded RN sandbox renders every connection and
recoverable cached record without dialing.

## Slice 3: Connections and pairing over authenticated WS

Port pairing URL parsing and exact credential precedence. Make credential
persistence transactional: new secrets are verified before old pairing/legacy
credentials are retired.

Implement the WS state machine and protocol codecs. Application traffic remains
blocked until backend `ready`. Add heartbeat, bounded pending requests,
network-aware reconnect, close-code mapping and per-connection ownership.

Build Connections and Pair routes with scanner/manual/edit/remove/connect
behavior and all RN loading, permission, offline and error states.

Acceptance: pair a backend, relaunch, revoke/re-pair, switch networks and prove
no outbox traffic crosses before authenticated readiness.

## Slice 4: Projects and conversations

Port typed application-channel DTOs and repositories keyed by connection plus
request generation. Build project grouping, collapsed workspaces, thresholds,
search, pull-to-refresh, unread aggregation, conversation ordering, rename and
new-session navigation.

Acceptance: stale responses and same thread IDs across connections cannot bleed;
configuration changes retain route and scroll state.

## Slice 5: Thread snapshot and complete event reducer

Add an authoritative backend session descriptor/snapshot where current channels
cannot reconstruct state. Decode every runtime event. Persist reduced events and
cursor atomically; hold live events behind replay and invalidate only the
affected connection on a gap.

Build the feed, Markdown, reasoning, plan, tool, denial, approval, question,
file-edit, retry, drift, spend, peer and todo presentations. Coalesce streaming
without violating FIFO.

Acceptance: backend restart, replay gap, process death and rapid multi-connection
events reconstruct the same feed and authoritative session state.

## Slice 6: Durable composer and turn delivery

Persist the message and private copies of attachments before clearing the
composer. Deliver through one FIFO actor per thread with stable origin IDs and
typed retryability. Add durable backend acceptance/deduplication.

Build draft persistence, slash commands, optimistic bubbles, waiting count,
interrupt behavior, image selection/limits and failure restoration.

Acceptance: kill the app at every enqueue/send/ack boundary and deliver each
accepted turn exactly once after restart.

## Slice 7: Authoritative provider controls

Return mode, model, provider and resolved profile from session attach/start.
Persist mutations through atomic backend channels and serialize phone changes.
Implement provider/model/profile/mode selectors and new-session ordering.

Replace stop-first profile rotation with an atomic operation or verified
rollback.

Acceptance: desktop and phone remain consistent under rapid changes and a
failed rotation keeps the prior session usable.

## Slice 8: Approvals, questions and plans

Persist pending control actions with request IDs and idempotency. Do not resolve
cards before acknowledgement events. Add failed/retry states and process-death
recovery. Preserve plan Implement/Iterate semantics and informational mobile
file-edit cards.

Acceptance: repeated taps, offline actions and ambiguous responses never falsely
show completion or execute twice.

## Slice 9: IAP and Google credentials

Port Google credential import/refresh/revoke with legacy SecureStore migration.
Implement IAP streaming UTF-8 framing, bounded queues, backend-authenticated
readiness, timeout removal, reconnect and snapshot recovery. Preserve manual and
discovered IAP targets.

Acceptance: split UTF-8 frames, tunnel drops, token expiry, process death and
network handoffs match WS-visible behavior.

## Slice 10: Images and voice

Complete image previews/lightbox and outbox-owned attachment lifecycle. Add
native speech partial/final accumulation, hold/lock/cancel gestures, background
shutdown, optional backend refinement and user-wins replacement.

Acceptance: permission denial, backgrounding, editing during refinement,
timeouts, cleanup and memory pressure do not lose user text or leak files.

## Slice 11: Push, viewing and unread state

Exchange FCM tokens for Expo push tokens using the existing EAS/Firebase
identity. Register/unregister per backend, preserve channel settings, consume
notification intents once, wait for connection readiness and restore routes on
cold start.

Make viewing leases and read state authoritative and recover unread counts after
process death.

Acceptance: foreground/background/killed delivery, token rotation, removed
connections and cold-start taps route exactly once to the correct backend.

## Slice 12: Native feel, accessibility and certification

Complete typography, iconography, press feedback, stable streaming layout,
keyboard/inset behavior, custom edge swipe, reduced motion and TalkBack
semantics. Compare every parity-checklist state on physical hardware.

Run API 24 and current-device production-signed v0.4.0 upgrades with seeded WS,
IAP, SecureStore, preferences, drafts, cached feeds, outbox text/images and push
identity. Verify first launch offline, migration interruption, reconnect,
exactly-once sends, updater flow, package, signer, version metadata, icon and
checksum.

Only after this matrix passes may the native release replace the public Android
APK. Report automated, emulator, physical-device and unexercised coverage
separately.
