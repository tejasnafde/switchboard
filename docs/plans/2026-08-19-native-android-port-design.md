# Switchboard Native Android Port Design

## Goal

Replace the Android Expo/React Native client with a native Kotlin and Jetpack
Compose application without reducing behavior or breaking installed users. The
existing React Native application remains the iOS client and the behavioral
oracle until the native Android release is certified.

The port is behavior-first. Screens are not translated component-for-component.
Each vertical slice owns storage, protocol, state, UI, lifecycle behavior, and
tests, and leaves an installable native build.

## Release invariants

- Keep application ID `app.switchboard.mobile`.
- Keep the production signing certificate whose SHA-256 fingerprint is
  `BC:81:1E:37:12:C2:D5:7F:2B:6E:BD:A5:43:92:E6:2E:BD:2A:77:34:53:E5:0F:B3:75:E1:10:2D:B9:01:A8:F6`.
- Start the native release at version name `0.5.0` and version code `2` or
  greater. The public `0.4.0` APK uses version code `1`.
- Keep min SDK 24 and target SDK 36.
- Preserve the `switchboard:` and Google OAuth callback schemes.
- Preserve the Firebase project, notification channel `switchboard-agents`,
  canonical icon assets, fonts, permissions, cleartext LAN support, and portrait
  dark presentation.
- Continue publishing `mobile-v<version>` GitHub Releases containing
  `switchboard-<version>.apk`.
- Native Android uses signed APK updates only. EAS Update remains enabled only
  for the temporary React Native iOS client.
- Existing RN clients and desktop/server versions continue to speak the current
  protocol. Backend changes for correctness are additive and capability-aware.

## Project structure

The native application lives in `apps/android`. `apps/mobile` stays in place for
iOS and parity comparison.

Release builds use `app.switchboard.mobile`. Debug builds use
`app.switchboard.mobile.native.dev`, allowing RN and native builds to coexist on
development devices.

The Android project is a single Gradle application initially, separated into
deep packages rather than prematurely split modules:

- `compat`: read-only legacy storage and notification-identity readers;
- `protocol`: wire DTOs, codecs, WS/IAP framing, authentication and replay;
- `data`: Room, encrypted credentials, attachments, outbox and cached state;
- `domain`: connection-scoped repositories and serialized mutation actors;
- `ui`: Compose navigation, routes, components and immutable presentation state;
- `platform`: camera, speech, connectivity, push notifications and updater.

UI code never owns sockets, databases, or retry loops. Transport callbacks never
mutate UI state directly. Repositories reduce typed results into durable state,
and lifecycle-aware view models expose immutable flows to Compose.

## Legacy-data migration

Migration is a startup gate. No default state, socket, push registration, or
background worker starts until it completes or produces a visible recovery
state.

The compatibility reader inventories and reads without modifying:

- AsyncStorage `RKStorage/catalystLocalStorage` and the defensive
  `AsyncStorage/Storage` layout;
- `sb-connections`;
- `switchboard-prefs`;
- `sb-chat-cache`;
- every `sb-outbox:<messageId>` record;
- Expo SecureStore `SecureStore` preferences and Android Keystore aliases;
- connection-token keys `sb-token-<safeConnectionId>`;
- device-session keys `sb-session-<safeConnectionId>`;
- all six `sb.google.*` credential keys;
- Expo notification installation and registration files.

Migration decodes all available data into staging models. It preserves
connection IDs, thread keys, message IDs, runtime modes, drafts, models,
profiles, collapsed workspaces, cached feed items, images, retry metadata and
credentials. Malformed noncritical records are quarantined and reported.
Missing credentials, unreadable outbox records, or partial connection records
must never be interpreted as an empty account.

Native records are written to a uniquely named Room database in one transaction.
Credentials are copied to a native Android-Keystore-backed store and read back.
Counts and content hashes are verified before a migration-complete marker is
written. The entire process is idempotent across process death. RN databases,
SecureStore records and Expo notification files remain untouched through the
compatibility window.

## Transport and connection semantics

Every runtime object and durable record is keyed by connection ID. Identical
thread IDs on different backends cannot share state.

The WS transport implements explicit phases: disconnected, dialing, socket-open,
authenticating, resuming and ready. `connected` means the backend sent `ready`,
not merely that the socket opened. No application request or outbox item flushes
before ready.

The transport preserves `req/res`, `snd`, ordered `evt`, auth, hello/ready and
ping/pong frames. It persists epoch and cursor only after an event is reduced
durably. Replay is applied exactly once and live events wait behind it. A gap
invalidates only that connection and triggers an authoritative snapshot.

Network loss parks reconnect backoff. Network return redials immediately. A
short background interval probes existing connections; a longer interval forces
reconnect. Foregrounding also renews viewing leases and drains durable work.

IAP implements the same application-level readiness and lifecycle contract as
WS: streaming UTF-8 decoding, bounded queues, timeout removal, backend auth,
network-aware reconnect and snapshot recovery. Capability detection handles old
servers without pretending replay succeeded.

## Durable commands and authoritative state

User intent becomes durable before the UI clears it. A turn transaction stores
text, images copied into private app storage, selected runtime mode, stable
origin/message ID and timestamp before clearing the composer or publishing an
optimistic bubble.

A per-thread actor delivers oldest-first. Different threads may deliver in
parallel. Retryability is typed, transport ambiguity keeps the record, malformed
records are quarantined, and accepted origins are durably deduplicated by the
backend beyond a process restart.

Runtime mode, model, provider and credential profile are backend-authoritative.
Opening a thread consumes an authoritative session descriptor instead of pushing
a stale phone preference. Mutations are serialized and persisted atomically.
Profile rotation is one backend-owned operation or rolls back to the previous
descriptor; it never stops the old session and leaves the conversation stranded.

Approvals and question answers use durable pending actions. Cards move through
pending-send, acknowledged and failed states. Only backend events finalize them.

The runtime reducer handles every event in `provider-events.ts`, including retry,
model variants, worktree drift, spend blocks, peer messages and todos. Unknown
future events are retained as diagnostic notices rather than crashing.

## Native self-update

Self-update is part of the first milestone. The updater:

- scans the existing GitHub releases list;
- ignores drafts and prereleases;
- selects the newest `mobile-v<version>` release with an APK;
- shows availability and the exact version;
- downloads with determinate byte progress and indeterminate fallback;
- supports real cancellation and deletes partial files;
- writes `.part`, closes and fsyncs, verifies SHA-256, then atomically renames;
- inspects package ID, signer, version code and version name before installer
  launch;
- guards repeated taps synchronously;
- recovers from per-app unknown-source permission settings;
- exposes a `content://` URI through FileProvider;
- records the pending installation and verifies replacement on next launch.

Update state survives configuration changes and process recreation. Update
failure never blocks normal app startup.

The release workflow exports or installs the exact EAS production keystore,
asserts its public fingerprint, builds with checked-in monotonic version metadata,
runs unit/instrumentation/lint gates, verifies APK metadata and signer, publishes
the checksum, creates the existing mobile release, and verifies the uploaded
asset.

## Push notifications and deep links

The first native release preserves the backend's Expo push-token contract. It
uses the existing Firebase app and Expo project identity to exchange the FCM
token for an Expo token, then registers that token with every ready backend.
Token rotation re-registers everywhere. Removing a connection unregisters it.

The notification channel ID, label, priority and foreground behavior remain
stable. Payload routing requires both `threadId` and `clientRef`. Cold-start
intents are consumed exactly once and wait for migration plus target-connection
readiness before navigating. Invalid payloads are logged and ignored.

Focused threads renew viewing leases and mark newly visible activity read.
Process death cannot erase authoritative unread state; reconnect/snapshot rebuilds
it.

Both existing schemes remain registered. No new external deep-link route is
invented in this port.

## UI and behavioral parity

Compose retains the RN information architecture: Connections, Google Account,
Pair, Projects, Conversations, New Session and Thread. It preserves modal
behavior, pull-to-refresh, search thresholds, grouping, unread badges, provider
labels, errors, loading/empty states, native back and the thread edge-swipe.

Thread rendering retains user/image bubbles, Markdown, reasoning, plan streams,
tools, denials, approvals, questions, proposed plans, file-edit summaries,
notices, errors, duration, context and cost. Streaming updates are coalesced
without violating FIFO ordering, while interactive events flush immediately.

The composer preserves runtime/model/profile controls, slash commands,
provider-specific follow-up rules, durable optimistic sends, waiting-message
status, four-image/size limits, image-only sends, keyboard/safe-area behavior,
voice hold/lock/cancel gestures and user-wins transcript correction.

The visual system reuses the canonical icon, Instrument Sans, Geist Mono,
palette, restrained status colors, 44dp targets, stable streaming layouts and
immediate press feedback. Native accessibility adds complete TalkBack roles,
labels, selected state, progress announcements, traversal order, dynamic type,
contrast and reduced-motion handling without redesigning branding.

Known RN defects are corrected deliberately rather than preserved: credential
commit races, pre-auth outbox flushing, non-atomic enqueue, dropped runtime
events, stale provider settings, destructive profile rotation, falsely resolved
interactive cards, push cold-start races, `/image` not opening the picker, and
voice cancel not restoring the original draft.

## Vertical slices and fleet ownership

Implementation proceeds in dependency order:

1. Native scaffold, identity, release verification and updater state machine.
2. Legacy migration, Room schema, encrypted credentials and offline connection
   list.
3. Pairing plus authenticated WS readiness and lifecycle.
4. Project and conversation browsing.
5. Thread snapshot, complete runtime reducer and replay recovery.
6. Durable turn outbox and composer.
7. Authoritative mode/model/profile controls.
8. Approvals, questions and control actions.
9. IAP parity and Google credential management.
10. Images and native voice.
11. Push, viewing, unread and cold-start navigation.
12. Full UI polish, accessibility and lifecycle certification.

At most three Luna implementation agents work concurrently. Assignments are
bounded by packages and acceptance tests. The primary agent owns integration,
shared-contract changes, conflict resolution and full gates.

## Testing and release certification

Pure JVM tests port existing TypeScript decision cases for pairing, protocol,
resume, lifecycle, outbox, reducers, provider selection, images, transcript
replacement, push routing, version comparison and release selection.

Instrumented tests use checked-in fixtures for both AsyncStorage schemas and
Expo SecureStore. They cover migration process death, keystore failure,
configuration change, notification cold start, connection switching, backend
restart, replay gaps, durable sends, background/foreground, updater cancellation,
unknown-source return and installer intents.

Protocol golden fixtures are decoded by both TypeScript and Kotlin tests so the
wire contract cannot drift silently.

Before public release, install the untouched production-signed v0.4.0 APK on API
24 and a current physical Android device. Seed WS and IAP connections,
credentials, preferences, drafts, cached feeds, outbox items and images. Upgrade
without uninstalling, first launch offline, verify every migrated record, kill
the app during migration phases, reconnect and prove exactly-once delivery.

Then exercise pairing, Google credential import/refresh, LAN/WSS/IAP networking,
network handoff, camera, voice, images, push in foreground/background/killed
states, notification routing, updater discovery/progress/cancel/retry/installer,
TalkBack, large fonts, gesture navigation and hardware back.

Release reporting separates automated results, emulator checks, physical-device
smoke tests and unexercised cases. Compilation and unit tests alone never justify
a no-regressions claim.
