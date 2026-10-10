# Native Android push compatibility

## Goal

The native Android app must remain compatible with the Expo push tokens already
accepted by Switchboard backends while surviving process death and in-place
upgrades from the React Native APK. Push remains optional and must never prevent
normal connection or messaging behavior.

## Identity and token acquisition

Release builds use the existing Firebase Android application from
`apps/mobile/google-services.json`, the canonical package
`app.switchboard.mobile`, and EAS project
`efbb89d9-210f-4584-bf62-8186cd5fb476`. The build reads those existing values;
it does not create or duplicate project credentials. Debug retains its
`.native.dev` application suffix and explicitly disables remote push because no
Firebase application is registered for that package.

The installation identifier uses Expo Notifications' existing no-backup file
and legacy migration names so an upgrade keeps the same Expo device identity.
The Firebase registration token is exchanged with Expo using the request shape
implemented by `getExpoPushTokenAsync`: `type`, `deviceId`, `development`,
`appId`, `deviceToken`, and `projectId` are POSTed to Expo's official token
endpoint. A successful HTTP status is not sufficient; the response must contain
`data.expoPushToken` with a valid Expo token. Only the non-secret installation
identifier and current FCM-to-Expo token mapping are persisted.

## Backend registration and viewing

An application-scoped coordinator owns token rotation and backend registration.
It registers each exact ready transport scope with
`push:register(token, "phone", connectionId)`. Duplicate fleet observations and
callbacks do not duplicate a registration. A reconnect has a new scope and is
registered again. Token rotation best-effort unregisters the old Expo token on
currently ready backends before registering the new token. Explicit connection
removal unregisters while the old exact connection is still available. Missing
push channels on older backends and all registration/unregistration failures are
nonfatal.

Viewing reports use `push:viewing(token, threadId)` on the exact connection
scope. Enter, renew, leave, token rotation, and replaced scopes are fenced so a
stale callback cannot claim or clear another connection or thread. The runtime
exposes this behavior through a non-UI lease handle for later Thread UI wiring.

## Receiving and routing

A `FirebaseMessagingService` handles foreground notifications and future
data-only pushes. It accepts only exact, bounded route payloads and completion
kind, then posts the canonical content-free `Switchboard` / `Done` notification
through the existing notifier. The notification tap uses the existing durable,
bounded route inbox.

Existing Expo backend requests contain both notification and data fields.
Android displays those itself while the app is backgrounded or killed and does
not invoke `FirebaseMessagingService`; it delivers the data extras to the
launcher Activity when tapped. Application startup and new intents therefore
ingest the same bounded route into the durable inbox before navigation. This
preserves killed-process tap routing, but the OS-rendered killed-state copy
cannot be forced to the native content-free wording without a recipient-aware,
data-only backend contract. That limitation must remain explicit in release
reporting.

## Verification

Pure tests cover Expo request/response decoding, stable installation identity,
token rotation, exact-scope registration, stale callbacks, nonfatal old
backends, viewing transitions, and push payload policy. Android compilation
covers Firebase service/manifest integration and both release and debug
variants. A physical Firebase-capable device is still required to establish
token issuance, background/killed delivery, OS-rendered copy, and cold-tap
behavior.
