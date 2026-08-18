# Switchboard Native Android Behavioral Parity Checklist

This is the release checklist for replacing the React Native Android APK. The
React Native client is the behavioral oracle, but known correctness defects are
fixed deliberately. A checked item needs linked automated evidence or a dated
physical-device result; compilation alone does not satisfy a behavior.

Status marks:

- `[x]` implemented and covered by an automated check
- `[~]` implemented in part or awaiting integration/hardware verification
- `[ ]` not implemented
- `[H]` must be exercised on physical hardware
- `[U]` must be exercised by upgrading the production-signed v0.4.0 APK

## Release identity and replacement

- [x] Release application ID remains `app.switchboard.mobile`; debug uses
  `.native.dev`.
- [x] Native version starts at `0.5.0` / version code `2`, above public v0.4.0.
- [x] Both existing URI schemes, cleartext LAN policy, portrait mode, package
  label, notification channel ID, permissions, icon bitmaps and font files are
  preserved.
- [~] Release assembly verifies the expected production signer fingerprint;
  production keystore export remains a stop-ship prerequisite.
- [U] Install over the untouched public v0.4.0 APK without uninstalling.
- [U] Verify package ID, version name/code, signer, icon and APK SHA-256 after
  installation.
- [U] Verify the prior app's sandbox, databases and keystore aliases remain
  available to the native process.

## Startup and migration

- [x] Inventory both known AsyncStorage SQLite layouts read-only.
- [x] Decode connections, preferences, chat cache and every `sb-outbox:*` row.
- [x] Read Expo SecureStore current and legacy AES-GCM key layouts without
  modifying them.
- [x] Preserve credential priority: device session, pairing credential, inline
  token; an unreadable higher-priority secret blocks rather than silently
  downgrades.
- [~] Copy recoverable records into normalized Room storage in one verified,
  idempotent migration transaction.
- [~] Store native credentials in a separate Android Keystore alias and verify
  decrypt/readback before connection dialing is released.
- [~] Quarantine malformed noncritical records and surface recovery details;
  never interpret partial critical data as an empty account.
- [ ] Render migrated connections, preferences, drafts, cached feeds, outbox
  text and private attachment copies before starting network work.
- [ ] Resume safely after process death at every migration checkpoint.
- [H][U] First native launch offline shows all recoverable cached state.
- [H][U] Interrupted migration retries without duplication, loss or corruption.

## Self-update

- [x] Discover the newest non-draft, non-prerelease `mobile-v*` GitHub release
  and matching APK.
- [x] Parse successful HTTP response bodies and expose domain-level errors.
- [x] Show checking, available version, download progress, indeterminate
  progress, cancellation, verification, permission, installer and failure
  states.
- [x] Guard repeated actions synchronously; cancel queued or active downloads.
- [x] Resume identity-matching `.part` files, fsync, verify SHA-256 and atomically
  rename to `.apk`.
- [x] Preflight package ID, increasing version code, version name and exact
  installed signer set before launching the installer.
- [~] Recover through unknown-source permission settings and process recreation;
  confirm replacement on next launch.
- [H] Exercise discovery, progress, cancellation, retry, settings return and
  installer launch on a real device.
- [H][U] Update over production-signed v0.4.0 and verify data after relaunch.

## Connections and pairing

- [~] Home list shows every machine with label, target, WS/IAP kind, live /
  connecting / offline / error state and useful failure detail.
- [~] Empty state explains desktop and headless server pairing and offers QR
  scanning plus build identity.
- [~] Tap opens projects; long press offers edit, connect/disconnect and
  confirmed removal.
- [~] QR scan is the default WS flow; permission denial and retry are visible;
  unrelated QR codes do not wedge scanning.
- [x] Pairing parser accepts `ws:`/`wss:`, strips credentials from the endpoint,
  and preserves pairing-vs-token semantics.
- [x] Manual WS form accepts a full pairing URL and defaults the label to host.
- [ ] Editing with new credentials clears the old device session only after the
  replacement credential is durably verified.
- [ ] IAP target discovery merges and deduplicates targets across ready machines;
  manual project/zone/instance/port remains available with validation.
- [~] WS auth waits for backend `ready`, keeps requests bounded, persists replay
  cursor and rejects stale/cross-connection callbacks.
- [~] Application-scoped network monitoring treats transport presence (not WAN
  validation) as reachable, parks retry timers offline and redials immediately
  on regain only for desired connections. Foreground probes absences under 10s
  and generation-rebuilds longer absences without reviving explicit disconnects.
- [H] Exercise LAN `ws:`, remote `wss:`, token rejection, revoke/re-pair and
  network handoff.

Automated lifecycle evidence: `ConnectionDecisionsTest`, `ConnectionFleetTest`,
`WsCoordinatorTest`, `LifecycleResilienceCoordinatorTest`,
`NetworkReachabilityPolicyTest` and `AppVisibilityTrackerTest`.
Pairing parser/scanner evidence: `PairingFormPolicyTest`,
`PairingQrReducerTest` and `NavigationStateTest`; real camera permission,
recognition speed and scan-to-connect remain hardware checks.

## Projects and conversations

- [x] Decode current project, conversation, workspace, provider-instance,
  settings and session-start channels with exact positional arguments and
  preserve unknown successful-response fields.
- [ ] Projects load offline snapshot first, then best-effort refresh.
- [x] Group projects by workspace, preserve backend ordering and
  connection-scoped collapse preferences, aggregate unread state and show
  counts/status. Migrated global collapse rows seed the scoped preference.
- [~] Search appears at the RN threshold and filters groups without empty
  shells; native pull-to-refresh remains to be added.
- [~] Projects expose loading, empty, offline and retryable error states;
  domain-specific unsupported presentation still needs real backend fixtures.
- [~] Conversations sort like the RN client, show unread/runtime status and
  search at the RN threshold; native pull-to-refresh remains to be added.
- [x] Long press rename updates optimistically, restores the old title on
  definite rejection, and keeps a successful rename successful when its
  follow-up refresh fails. The project exposes a real new-session route.
- [x] Project, conversation and activity state are fenced by connection plus
  transport generation; conversation loads are additionally scoped by project.
- [~] Serializable routes, saveable query/dialog state, scoped collapse state
  and stale-load cancellation survive configuration/device switches. Physical
  process recreation and scroll restoration still need instrumentation/device
  verification.

Automated projects/conversations evidence: `BrowseParityDecisionsTest`,
`BrowseCollapsePreferencesTest`, `BrowseThreadActivityIndexTest`,
`BrowseCoordinatorTest`, `BrowsePresentationTest`,
`SwitchboardRemoteClientTest` and `NavigationStateTest`.

## New session and authoritative controls

- [~] Provider instances/profiles and defaults come from the selected backend.
  Pre-session models intentionally use the exact RN static catalog because the
  backend model-list channel requires an already-started thread.
- [x] Provider/model/profile ordering and backend-authoritative defaults match
  RN behavior; unknown backend model defaults remain selectable and malformed
  runtime defaults fall back to Sandbox.
- [ ] Absolute play/pause-style controls remain absolute commands, never
  toggles.
- [x] Provider default loads are request-fenced; switching provider clears stale
  profile/model selections, and launch locks the committed configuration before
  the backend session is created.
- [ ] Failed profile rotation keeps or rolls back to the prior usable session.
- [x] New sessions run `createConversation` then `startSession`; an optional
  first message enters only the durable outbox. Failed durable enqueue preserves
  the text and retries the write without recreating/restarting the session.
- [x] Command success and best-effort follow-up refresh failure are presented as
  separate outcomes.

Automated new-session evidence: `NewSessionDecisionsTest`,
`NewSessionCoordinatorTest`, `SwitchboardRemoteClientTest` and
`NavigationStateTest`. Provider authentication, touch feel, keyboard behavior
and first-message delivery still require physical-device/backend smoke testing.

## Thread snapshot and runtime events

- [~] Decode all current runtime event variants and preserve unknown extensions
  as visible diagnostic notices.
- [~] Key feeds, snapshots, pending requests and raw journals by connection plus
  thread and transport generation.
- [~] Coalesce adjacent streaming chunks without crossing interactive or
  non-content barriers.
- [~] Deduplicate event echoes and repeated cards using stable identities.
- [~] On replay gap, invalidate only affected connection data; buffer live
  events per thread until snapshot replacement, then replay FIFO.
- [ ] Render user/image messages, Markdown, assistant/reasoning/plan streams,
  tools, denials, approvals, questions, proposed plans, file edits, errors,
  notices, retry, drift, spend, peer and todo events.
- [ ] Show duration, cost/context metadata and stable connection/thread status.
- [ ] Mark/renew viewing leases while focused and reconstruct unread state after
  process death.
- [ ] Edge-swipe back starts only at the left edge, yields to vertical feed
  scrolling and commits only past threshold; Android system back also works.
- [H] Compare streaming stability, Markdown typography, scrolling and touch
  latency against RN on a real device.

## Durable composer and delivery

- [x] Persist text, selected mode, stable origin/message ID and private copies
  of attachments before clearing the visible composer.
- [~] Restore connection/thread-scoped drafts and failed/unsent content from
  Room after runtime recreation; physical process-death restoration remains.
- [x] Per-thread FIFO delivery allows other threads to progress independently;
  no send occurs before authenticated readiness.
- [x] Retries preserve origin ID and chosen mode; typed permanent failures stop;
  ambiguous transport failures remain durable.
- [~] Durable queued/ambiguous/terminal cards expose valid retry/edit/dismiss
  actions and image-only sends are allowed; full optimistic/feed parity remains.
- [ ] Slash menu includes built-ins plus provider skills; `/image` opens native
  image selection and mode commands change the actual send mode.
- [~] Up to four images have bounded previews and removal; size/downscale limits
  and lightbox remain. Owned attachment files are removed only after the Room
  ownership transition, acknowledgement, replacement or explicit safe dismiss.
- [ ] Slider-like controls serialize/coalesce writes and guarantee final release
  wins over older drag requests.
- [H] Kill at enqueue, send, backend accept and acknowledgement boundaries and
  verify each accepted turn is delivered exactly once.

Automated composer/delivery evidence: `ComposerDraftPolicyTest`,
`ComposerDraftCoordinatorTest`, `RoomComposerDraftStoreTest`,
`PrivateComposerAttachmentStagerTest`, `PrivateFilesAttachmentStagerTest`,
`OutboxCoordinatorTest`, `OutboxRuntimeTest`, `ThreadSessionCoordinatorTest`
and compiled `SwitchboardDatabaseTest` migration/preservation coverage. The
picker grant, preview rendering, configuration/process recreation, low-storage
failure and real backend delivery/edit flows still require device testing.

## Approvals, questions and plans

- [ ] Approval allow/deny actions use durable request IDs and remain visibly
  pending until backend acknowledgement.
- [ ] Question cards support single/multi-select, submit answers together and
  restore pending selections after process recreation.
- [ ] Proposed plans preserve Implement and Iterate semantics.
- [ ] Repeated taps are idempotent; offline and ambiguous results never show a
  false completion.
- [ ] Mobile file-edit cards remain informational where the backend does not
  support phone-side hunk application.

## Google account and IAP

- [ ] Sign-in screen supports browser OAuth and QR credential import, signed-in
  identity, refresh, revoke/sign-out, cancellation and permission errors.
- [ ] Migrate all six `sb.google.*` credential keys without deleting Expo data.
- [ ] Refresh before expiry, serialize refresh, and turn invalid grants into a
  signed-out state instead of an infinite retry loop.
- [ ] IAP transport handles split UTF-8 frames, bounded queues, timeouts,
  backend auth/readiness, tunnel drops and snapshot recovery.
- [H] Exercise real Google login/refresh/revoke and IAP to discovered and manual
  targets through backgrounding and network changes.

## Voice, lifecycle and dynamic hardware

- [ ] Mic tap/hold semantics, live partial transcript, stop/send decision,
  slide-up lock and sideways cancel match RN.
- [ ] Cancel restores the original draft; edits made during optional transcript
  refinement always win over stale refinement output.
- [ ] Permission denial shows an actionable settings path; backgrounding stops
  capture cleanly and no recorder/listener leaks survive screen destruction.
- [ ] Temporary display/service/process disappearance is treated as dynamic
  topology; recovery does not overwrite the user's saved display preference.
- [~] Process visibility ignores pause-only transitions and configuration
  replacement; real foreground transitions renew registered viewing leases,
  wake the outbox and apply the short-probe/long-reconnect policy. Notification
  tap routes persist across process recreation and are consumed once.
  Draft/pending-work/update restoration remains separate.
- [H] Exercise microphone, Bluetooth/device topology changes, service death and
  low-memory process recreation.

## Push, notifications and deep links

- [~] Canonical release resources are derived from the existing RN
  `google-services.json`; Expo's existing no-backup installation UUID is reused
  and native FCM tokens are exchanged through the official EAS-project Expo
  token contract. The `.native.dev` build remains installable with remote push
  explicitly disabled. Real token issuance still requires a Firebase-capable
  device.
- [~] Registration is idempotent per exact ready scope; reconnect and token
  rotation re-register, old tokens and explicitly removed ready machines are
  unregistered best-effort, and domain failures in 2xx bodies remain nonfatal.
  Viewing enter/renew/leave has an exact-scope native runtime seam; Thread UI
  registration and device verification remain pending.
- [~] Preserve the high-importance `switchboard-agents` / `Agent activity`
  channel. Process-alive background `turn.completed` events now post canonical,
  content-free `Done` / duration copy. `FirebaseMessagingService` does the same
  for foreground/future data-only completion payloads, while notification+data
  cold taps are bounded and persisted from launcher extras. Android renders the
  existing notification+data copy itself while killed, so content-free killed
  copy requires a future recipient-aware/data-only backend contract. Delivery
  remains hardware-unverified.
- [~] RN exposes no notification action buttons, and the native completion
  notice remains tap-only. Any future command actions still require absolute
  semantics and idempotent request identity before release.
- [~] Notification routes require both `clientRef`/connection and thread
  identity, carry exact fleet generation internally, persist before Activity
  launch, and deduplicate consumption across process recreation. Navigation
  waits for startup/target resolution; foreground and killed-process remote tap
  delivery still require device verification and the Expo/FCM lane.
- [ ] Existing deep-link schemes route safely; malformed or cross-connection
  payloads are ignored visibly/logged, never guessed.
- [H] Exercise delivery and taps in foreground, background and killed states.

Automated evidence for the partial native notification/push slice:
`NotificationRouteCodecTest`, `NotificationRouteInboxTest`,
`AppVisibilityTrackerTest`, `NotificationPermissionPolicyTest`,
`BackgroundTurnNotificationCoordinatorTest`, `ProtocolEventHubTest` and
`AuthenticatedConnectionFleetCoordinatorFactoryTest`, plus
`ExpoPushTokenContractTest`, `ExpoInstallationIdentityTest`,
`PushTokenRuntimeTest`, `PushRegistrationCoordinatorTest`,
`RemotePushNotificationPolicyTest` and `SwitchboardRemoteClientTest`.

## Native feel, accessibility and release reporting

- [ ] Reuse canonical neutral-black palette, Instrument Sans and Geist Mono;
  branding/iconography is not redesigned implicitly.
- [ ] Every interactive control has immediate press feedback and at least a
  44dp target; streaming and progress updates avoid layout jumps.
- [ ] Typography, keyboard/insets, gesture navigation, reduced motion, contrast,
  TalkBack roles/labels/state and large fonts are verified.
- [ ] Gestures do no avoidable network work; expensive refreshes are debounced
  and stale polling is cancelled.
- [H] Compare touch feel, input latency, scrolling, installer, notification,
  voice and hardware behavior throughout the port.
- [ ] Release report separates JVM/unit, instrumentation/emulator, physical
  smoke coverage and unexercised cases; it never equates build success with
  “no regressions.”
