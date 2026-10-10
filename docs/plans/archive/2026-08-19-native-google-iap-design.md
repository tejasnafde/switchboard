# Native Google Identity and IAP Design

**Date:** 2026-08-19  
**Status:** Approved for implementation  
**Scope:** Android behavioral parity for Google credentials, OAuth, QR import, IAP discovery, and the Cloud IAP relay transport

## Outcome

The native Android app can reuse the Google identity already stored by the React Native app, import credentials minted by the desktop, refresh and revoke credentials safely, discover IAP targets through connected Switchboard backends, and connect to those targets through Google's Cloud IAP WebSocket relay.

The port preserves the existing package, OAuth client and callback scheme, six Expo SecureStore keys, backend channels, IAP framing, backend authentication, readiness, cursor replay, and RPC behavior. Native code may read legacy storage but must never mutate it. A native sign-out clears only native-owned Google state.

## Behavioral source of truth

The React Native app is the behavioral specification, principally:

- `apps/mobile/src/lib/google-auth.ts`
- `apps/mobile/src/lib/iap-transport.ts`
- `apps/mobile/src/stores/connections.ts`
- `apps/mobile/src/screens/SignInScreen.tsx`
- `apps/mobile/src/screens/PairScreen.tsx`
- `src/shared/iap-tunnel.ts`
- `src/shared/google-oauth.ts`
- `src/main/google/mint.ts`
- `src/main/ipc/machines.ts`

Native implementation fixes known transport correctness issues, such as decoding split UTF-8 with a fresh decoder and keeping an unbounded pre-ready queue, without changing the backend contract.

## Chosen architecture

Use the existing authenticated backend protocol through a transport-neutral line seam. WebSocket and Cloud IAP are dialers beneath the same authentication, capabilities, readiness, resume-cursor, replay, event, and RPC coordinator.

A separate IAP coordinator was rejected because it would duplicate application-protocol behavior and drift. A standalone React Native-style remote RPC tunnel was rejected because it would bypass the native fleet's lifecycle, generation fencing, and replay guarantees.

The first implementation pass adds isolated domain and platform files. Shared fleet, runtime, activity, and navigation integration happens only after ownership is coordinated.

## Google credential model

The native credential unit is a coherent bundle:

```text
GoogleCredentialBundle
  clientId: nonblank string
  clientSecret: optional nonblank string
  refreshToken: nonblank string
  accessToken: optional nonblank string
  expiresAtEpochMs: optional positive long
  email: optional nonblank string
```

Client secret remains optional. Android OAuth clients do not carry a client secret, and native code must not invent or substitute one.

The native store uses a dedicated Android Keystore alias and encrypted preference namespace, separate from connection credentials. A write follows stage, read back, compare, then promote. A failed write or mismatching readback leaves the previously active native bundle unchanged.

## Legacy migration

The migrator reads these exact Expo SecureStore keys:

- `sb.google.refresh_token`
- `sb.google.access_token`
- `sb.google.expires_at`
- `sb.google.email`
- `sb.google.client_id`
- `sb.google.client_secret`

Migration rules:

1. Read all keys without modifying Expo storage.
2. Treat a missing refresh token or client ID as no coherent migratable identity.
3. Validate optional fields independently; malformed optional cache fields do not corrupt the required refresh identity.
4. Verified-write the coherent bundle to native storage.
5. Mark migration complete only in native-owned state and only after successful readback.
6. Existing valid native credentials take precedence over legacy values.
7. Retrying migration is idempotent.

Revoke and sign-out never delete, overwrite, or revoke through the legacy Expo copy. The legacy credential remains upgrade-compatible evidence; native active state is authoritative after migration.

## OAuth and QR import

The canonical Android client ID and reversed-client callback scheme remain unchanged. Browser OAuth uses authorization code plus PKCE S256, cloud-platform/openid/email scopes, offline access, consent prompt, and an exact redirect URI.

Every callback must contain the exact generated state. Missing or mismatched state is ignored and cannot cancel or complete the flow. A current attempt owns its verifier, state, and generation. Late callbacks from cancelled or replaced attempts are ignored.

Browser states are explicit:

- idle
- launching
- awaiting callback
- exchanging code
- signed in
- cancelled
- timed out
- retryable failure
- unavailable for this build

Browser sign-in remains visible. Known `invalid_client`, redirect mismatch, and Android signing/client incompatibility failures map to a nonfatal `UnavailableForBuild` result whose recovery action is QR import. QR import stays visible throughout. Native code never falls back to a secret-bearing desktop client and never guesses production credentials.

QR import accepts the existing canonical JSON object containing `clientId`, optional `clientSecret`, and `refreshToken`. A bare token beginning `1//` is accepted only when a local canonical client ID is available. Imported credentials must obtain a valid access token before being activated and persisted. Failure retains the previously active native bundle.

## Token lifetime and sign-out

Access tokens refresh when missing or within 60 seconds of expiry. Concurrent callers share one refresh operation. A superseded refresh response cannot overwrite newer credentials.

On `invalid_grant`, the coordinator clears native Google state once, transitions to signed out, and does not enter a refresh loop. Transient network and server failures preserve the refresh token and surface a retryable error.

Sign-out performs best-effort revocation using the refresh token, falling back to the cached access token only when required by the existing behavior. Local native state is cleared even when revocation fails. Legacy Expo data remains untouched.

## IAP target discovery

Each ready backend is queried through the exact `machines:list-iap-targets` channel. Source failures contribute an empty list and do not fail the whole discovery.

Results are merged in ready-connection order. The first target wins for duplicate `(project, zone, instance)` tuples. Alias is display metadata, not part of identity. Selecting a discovered target uses the current/default port because the existing backend target object has no port.

Manual target validation requires:

- nonblank trimmed project
- nonblank trimmed zone
- nonblank trimmed instance
- integer port in `1..65535`

The default application port remains `8766`.

## Cloud IAP relay contract

The Android relay uses OkHttp WebSocket with:

- host `tunnel.cloudproxy.app`
- path `/v4/connect`
- subprotocol `relay.tunnel.cloudproxy.app`
- `Origin: bot:iap-tunneler`
- `Authorization: Bearer <Google access token>`
- `User-Agent: switchboard-mobile`
- exact query order: project, port, newWebsocket=True, zone, instance, interface
- default interface `nic0`

Binary relay frames use big-endian fields:

- `CONNECT_SUCCESS_SID` = `0x0001`
- `RECONNECT_SUCCESS_ACK` = `0x0002`
- `DATA` = `0x0004`
- `ACK` = `0x0007`
- data header = 16-bit tag plus 32-bit payload length
- acknowledgement = 16-bit tag plus 64-bit cumulative byte count
- maximum DATA payload = 16 KiB
- acknowledgement cadence = 32 KiB

Malformed or truncated frames close the attempt with a protocol error. A reconnect-success frame advances relay state without bypassing backend authentication or readiness.

## Line framing, bounds, and readiness

The relay's DATA payload is an arbitrary byte stream. An incremental UTF-8 decoder carries incomplete multibyte sequences across frames, and an NDJSON splitter carries partial lines across frames. Invalid terminal UTF-8 is a protocol failure rather than silent replacement.

Outbound application lines written before relay/backend readiness enter a bounded FIFO. Queue overflow fails explicitly; it never silently drops or grows without limit. Invoke requests have bounded per-call timeouts. Tunnel drop fails every pending invoke and clears the unsent queue.

Opening the outer WebSocket means `Connecting`, not `Ready`. Readiness requires:

1. outer WebSocket open;
2. IAP relay connect success;
3. backend token authentication;
4. backend ready/capabilities handshake.

Only then may the fleet expose an endpoint or replay/resume application traffic.

## Concurrency and lifecycle

Every connect attempt receives both a fleet generation and a transport attempt generation. Token, socket, callback, timer, and decoder events carry their owning generation. Stale callbacks are ignored after reconnect, target switch, explicit disconnect, lifecycle stop, or credential invalidation.

Token refresh is serialized independently of connection attempts, so multiple IAP connections can share one refresh without sharing socket state. Cancellation closes the owned socket and timers and cannot close a replacement attempt.

## Failure presentation

Domain failures are typed so UI copy does not depend on parsing exception strings:

- Google sign-in cancelled or timed out
- browser OAuth unavailable for this build, with QR recovery
- credential import invalid or verification failed
- signed out because Google revoked/expired the grant
- target invalid
- Google token temporarily unavailable
- relay rejected authorization
- malformed relay frame
- queue full
- backend authentication failed
- backend readiness timed out
- tunnel disconnected

A follow-up refresh failure after a successful command must not rewrite that command as failed; this remains the existing authenticated protocol coordinator's responsibility.

## TDD and verification plan

Pure JVM tests are written before implementation for:

- credential bundle validation, QR parsing, and exact legacy key mapping
- verified-store rollback/readback and legacy preservation
- migration precedence and idempotence
- strict OAuth state, cancellation, timeout, error classification, and stale callbacks
- serialized refresh, refresh skew, superseded responses, and one-shot `invalid_grant`
- revoke/sign-out semantics
- discovery ordering, failure isolation, dedupe, and manual validation
- relay URL/header contract, tags, big-endian codec, fragmentation, ACK cadence, and malformed frames
- split UTF-8, partial/multiple NDJSON lines, and invalid terminal bytes
- bounded queue overflow, invoke timeout, drop cleanup, readiness gating, and stale-generation fencing

The tests may be created before the Gradle lane opens, but neither targeted nor full Gradle commands run until the root agent explicitly coordinates access. Later hardware validation must exercise browser callback delivery, QR scanning, token refresh, IAP connectivity, background/reconnect, process recreation, and upgrade over the production-signed prior APK.

## Compatibility guardrails

- Package remains `app.switchboard.mobile` for production.
- Existing signing identity and update channel remain untouched.
- Existing OAuth client ID and manifest schemes remain canonical.
- No client secret or production credential is introduced.
- All six Expo keys are read-only.
- Backend channel names, auth message, NDJSON, relay framing, and readiness remain exact.
- Native sign-out affects only native-owned Google state.
- Browser OAuth limitations are explicit and nonfatal; QR is always available.
