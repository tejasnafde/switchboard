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
- [x] Current native release is `0.5.4` / version code `6`, monotonically above
  the installed `0.5.3` / version code `5` build.
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

Migration evidence includes pure importer/checkpoint/idempotency tests and a
compiled Android `MigrationTestHelper` v1-to-v4 fixture covering connections,
credential refs, preferences, cached chat/feed, outbox/attachments, replay,
pending controls, checkpoints and quarantine, followed by foreign-key and
SQLite integrity checks. That instrumentation fixture has not been executed on
an emulator/device, and it is not a substitute for the production APK upgrade.

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
- [x] Editing with new credentials stages and readback-verifies a fresh native
  key, atomically CASes the full Room row plus credential ref, and retires the
  old native key only after commit. Stale/failing edits preserve prior state;
  post-commit cleanup failure leaves a harmless orphan rather than rolling back.
- [~] Manual IAP creation/editing validates project/zone/instance/port, stores
  the backend token only in native encrypted storage and preserves the secret
  for unchanged offline edits. Target discovery/merge across ready machines
  remains.
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
- [x] Projects and conversations load connection-scoped Room snapshots first,
  then best-effort refresh. Successful refreshes preserve exact backend objects;
  malformed cached scopes cannot discard valid scopes.
- [x] Group projects by workspace, preserve backend ordering and
  connection-scoped collapse preferences, aggregate unread state and show
  counts/status. Migrated global collapse rows seed the scoped preference.
- [x] Search appears at the RN threshold and filters groups without empty
  shells; projects and conversations both support native pull-to-refresh.
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
`RoomBrowseSnapshotStoreTest`, compiled Room v3-to-v4 migration coverage,
`SwitchboardRemoteClientTest` and `NavigationStateTest`.

## New session and authoritative controls

- [~] Provider instances/profiles and defaults come from the selected backend.
  Pre-session models intentionally use the exact RN static catalog because the
  backend model-list channel requires an already-started thread.
- [x] Provider/model/profile ordering and backend-authoritative defaults match
  RN behavior; unknown backend model defaults remain selectable and malformed
  runtime defaults fall back to Sandbox.
- [x] Existing threads request live model options with request/generation
  fencing and issue an absolute model selection only after validating the
  option; rejection preserves the prior reported model.
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
- [~] Render text messages, Markdown, assistant/reasoning/plan streams,
  tools, denials, approvals, questions, proposed plans, file edits, errors,
  notices, retry, drift, spend, peer and todo events. Historical image-only
  messages, bounded raster data URLs and tool calls now survive snapshot decode;
  images render off-main-thread inline with a full-screen lightbox. Remote URL
  image loading remains.
- [x] Show duration, cost/context metadata and stable connection/thread status;
  the metric strip exposes one combined accessibility summary.
- [~] A visible, ready thread enters an exact transport-generation viewing
  lease; backgrounding, disposal, device switches and stale callbacks leave or
  reacquire without crossing scopes. Unread reconstruction after process death
  still needs instrumentation/device coverage.
- [x] Edge-swipe back starts only at the left edge, yields to vertical feed
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
- [x] Durable queued/ambiguous/terminal cards expose valid retry/edit/dismiss
  actions; image-only and captioned sends keep staged images in the optimistic
  feed and reconcile the eventual history echo without duplication.
- [x] Slash menu includes built-ins plus provider skills; `/image` opens native
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

- [x] Approval allow/deny actions use exact request IDs and remain visibly
  pending until backend acknowledgement.
- [~] Question cards support single/multi-select, submit answers together and
  save pending selections through Activity/process state; killed-process
  backend acknowledgement still needs device verification.
- [x] Proposed plans preserve Implement and Iterate semantics.
- [x] Repeated taps are idempotent; offline and ambiguous results never show a
  false completion.
- [x] Mobile file-edit cards remain informational where the backend does not
  support phone-side hunk application.

Automated thread/control evidence: `ThreadRichTextTest`,
`ThreadSlashCommandsTest`, `ThreadSessionCoordinatorTest`,
`ThreadSessionCommandRouterTest` and `ThreadPresentationTest`.

## Google account and IAP

- [~] The native Google account route exposes signed-out, signed-in/email and
  blocked recovery states, verified masked paste import, confirmed revoke/sign-
  out, cancellation fencing and fixed nonsecret errors. Its scan action clearly
  falls back to paste; native camera QR and browser OAuth remain.
- [~] A verified native encrypted store and idempotent, read-only importer cover
  all six `sb.google.*` credential keys without deleting Expo data. Startup runs
  the importer before fleet release and exposes independent Ready / Absent /
  Blocked Google state without blocking ordinary WS. Imported credentials are
  verified before activation and stale imports cannot replace newer state.
- [~] Native Google token exchange refreshes before expiry, serializes refresh,
  parses successful domain failures, and turns invalid grants into signed-out
  state instead of an infinite retry loop. Revoke is best-effort and uses
  expected-bundle compare-and-clear so a late sign-out cannot erase a newer
  account. The application-owned observable account runtime survives Activity
  recreation; browser/device execution remains.
- [~] IAP relay transport handles split UTF-8/NDJSON frames, bounded queues,
  typed overflow, connect timeouts, incremental relay parsing, backend auth and
  readiness, ACK windows, tunnel drops and stale callbacks. Valid stored rows
  resolve and auto-connect through the routed native fleet; signed-out/blocked
  prerequisites terminate with actionable error and no retry while WS remains
  independent. Real tunnel/snapshot recovery remains an integration check.
- [H] Exercise real Google login/refresh/revoke and IAP to discovered and manual
  targets through backgrounding and network changes.

Automated Google/IAP evidence: `GoogleStartupRuntimeTest`,
`GoogleCredentialImportCoordinatorTest`, `GoogleSignOutCoordinatorTest`,
`GoogleTokenHttpContractTest`, `GoogleAccountRuntimeTest`,
`GoogleAccountUiReducerTest`, `IapRelayTransportTest`,
`GoogleIapAccessTokenProviderTest`, `NativeConnectionTargetResolverTest`,
`NativeLineTransportCompositionTest`, `PairingFormPolicyTest` and
`NativeConnectionRepositoryTest`.

## Voice, lifecycle and dynamic hardware

- [x] Thread and New Session composers implement the RN mic semantics: 220 ms
  hold, live partial transcript, non-sending release/stop, 56 dp slide-up lock,
  72 dp sideways cancel, explicit locked stop, and tap-to-start/stop for the new
  session composer.
- [x] Cancel restores the exact original draft; edits made during optional
  transcript refinement always win over stale refinement output.
- [~] Android permission/settings and `SpeechRecognizer` adapters are integrated;
  pending-permission races are fenced and real background/disposal stops capture
  idempotently without treating configuration replacement as background. The
  physical permission dialog, microphone and audio routes remain unverified.
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
  Viewing enter/renew/leave is wired to exact-scope Thread UI lifecycle with
  generation fencing; device verification remains pending.
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
- [~] Both existing schemes are classified exactly. Google callbacks accept
  only the exact OAuth path, ACTION_VIEW, expected state and current generation,
  then consume code/denial once; `switchboard:` remains deliberately opaque so
  native code never guesses thread/project routes. Activity/browser delivery
  integration remains.
- [H] Exercise delivery and taps in foreground, background and killed states.

Automated evidence for the partial native notification/push slice:
`NotificationRouteCodecTest`, `NotificationRouteInboxTest`,
`AppVisibilityTrackerTest`, `NotificationPermissionPolicyTest`,
`BackgroundTurnNotificationCoordinatorTest`, `ProtocolEventHubTest` and
`AuthenticatedConnectionFleetCoordinatorFactoryTest`, plus
`ExpoPushTokenContractTest`, `ExpoInstallationIdentityTest`,
`PushTokenRuntimeTest`, `PushRegistrationCoordinatorTest`,
`RemotePushNotificationPolicyTest` and `SwitchboardRemoteClientTest`.
Deep-link parsing/fencing evidence: `SwitchboardDeepLinkContractTest` and
`GoogleOAuthCallbackPolicyTest`.

## Native feel, accessibility and release reporting

- [x] Reuse the canonical neutral-black palette, bundled Instrument Sans and
  Geist Mono files, and canonical launcher artwork; branding/iconography is not
  redesigned implicitly.
- [~] Connections, pairing, browse and new-session controls use Material press
  feedback, at least 48dp targets, explicit roles/state and fixed support
  regions that avoid progress/error layout jumps. The Google account surface
  has the same target/semantics/stable-slot treatment; Thread/update surfaces
  still need the same audit.
- [~] Core audited screens expose traversal groups, labels, state descriptions
  and live regions. Typography, keyboard/insets, reduced motion, contrast,
  TalkBack, Switch Access and large fonts remain physical-device checks.
- [ ] Gestures do no avoidable network work; expensive refreshes are debounced
  and stale polling is cancelled.
- [H] Compare touch feel, input latency, scrolling, installer, notification,
  voice and hardware behavior throughout the port.
- [ ] Release report separates JVM/unit, instrumentation/emulator, physical
  smoke coverage and unexercised cases; it never equates build success with
  “no regressions.”
