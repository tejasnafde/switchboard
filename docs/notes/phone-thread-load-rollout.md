# Phone thread loading rollout

Ship the backend before the phone clients to enable `history_window_v1` and
`heartbeat_v1`. Older phones keep the original full or legacy tail history
contract. New phones fall back to `{ limit }` against older desktops, without
sending window requests or timing out unsupported heartbeat probes.

The new window contract returns at most 200 rows in chronological order. A
`beforeId` cursor excludes that row and returns the immediately preceding page.
`nextBeforeId: null` ends paging. A removed cursor returns `cursorReset: true`
and a fresh tail, so the client refreshes rather than joining unrelated pages.
No transcript, conversation id, package identity, signing, deep link, database
schema, or existing update channel changes.

Android code changes require a later native APK release through the existing
Android release workflow. This change bumps the Android version to 0.5.16
(versionCode 18).
Expo changes are JS-only and can use the existing compatible OTA lane. Publishing
and hardware verification are separate release tasks. Test direct WebSocket and
IAP on hardware, including push taps, background return, clean resume, backend
restart, live text during refresh, and repeated older-page scrolls before release.

Backend parsing still reads and merges the full transcript. PR #241 owns parse
caching; this change only reduces wire history and unnecessary reloads. The
synthetic 6,800-row fixture uses 12,000 ASCII content characters per message:
82,016,037 bytes for a full load versus 2,412,399 bytes for the first 200-row
window, a 97.06% reduction. Real tool and image payloads differ.
