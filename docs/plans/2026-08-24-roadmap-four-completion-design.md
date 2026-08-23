# Roadmap Four Completion

## Problem

The project context still names four unfinished roadmap items: desktop code
signing, launch-config hot reload and startup orchestration, Cursor conversation
import, and provider hot-swap context preservation. The current tree has moved
ahead of that summary. Launch configs already hot-reload and support `wait_for`,
and same-provider OAuth profile switches already migrate native transcripts
transactionally. Cross-provider switches already use a bounded, one-time context
handoff. Cursor import is still absent, while signing remains deliberately
disabled because no production certificate is installed.

The release must close the gap between the roadmap and the product without
rewriting shipped behavior, reading mutable Cursor state unsafely, claiming
signing that did not happen, or breaking any Switchboard client.

## Decision

Finish the roadmap as one product change:

1. Add a read-only, versioned Cursor importer that understands both legacy
   workspace-local storage and the current global composer storage.
2. Snapshot explicitly selected Cursor conversations into Switchboard's database
   so every connected client can browse them without access to Cursor's files.
3. Preserve Cursor as import provenance while using Claude Code as the default
   continuation provider. The first accepted continuation turn reuses the
   existing bounded context-handoff mechanism; later turns use normal provider
   segments.
4. Add focused regression verification for launch-config reload/orchestration
   and OAuth-profile transcript preservation, then correct stale roadmap copy.
5. Make release signing conditional and fail closed on partial credentials.
   Unsigned builds remain supported; complete secrets activate production
   signing, notarization, and verification.
6. Release the next available patch only after all automated gates and an
   adversarial Claude review pass.

## Cursor Storage Adapters

Cursor databases are opened read-only with `fileMustExist`; Switchboard never
writes to them. Discovery supports two layouts:

- Legacy: each `workspaceStorage/<id>/state.vscdb` contains
  `ItemTable['composer.composerData']` with inline composer metadata.
- Current: `globalStorage/state.vscdb` contains `composerHeaders` plus
  `cursorDiskKV['composerData:<composerId>']` and
  `cursorDiskKV['bubbleId:<composerId>:<bubbleId>']` records.

Workspace IDs are matched to a project through the adjacent `workspace.json`.
File URIs are decoded and normalized before exact path comparison. Multi-root
workspace files are parsed only far enough to establish that the selected
project is a member. Malformed, missing, locked, or unsupported stores produce a
bounded diagnostic and do not prevent other provider transcripts from scanning.

Each adapter emits the same internal candidate shape: composer ID, title,
timestamps, workspace ID, and ordered bubble headers. Bubble type `1` maps to a
user message and type `2` maps to an assistant message. Empty and unsupported
bubbles are skipped. Message IDs are deterministic from composer and bubble IDs
so importing twice is idempotent.

## Import and Continuation Flow

Cursor candidates appear in the existing explicit Import/Recovery inventory;
they never flood the normal sidebar automatically. Import reads and normalizes
the selected transcript, then snapshots it into an app-owned managed
conversation in one transaction.

The conversation stores two distinct facts:

- `agent_type`: the runnable continuation provider (`claude-code` initially);
- `origin_source`: the imported provenance (`cursor`).

The sidebar projects `origin_source` for the badge while session startup uses
`agent_type`. A Cursor import has no provider-native resume ID. Its first new
turn therefore receives the existing bounded handoff preamble and records a
handoff marker. Once Claude emits a native session ID, the ordinary conversation
segment machinery resumes it on every client.

Imported messages are ordinary Switchboard messages after the snapshot. Search,
bookmarks, export, archive, fork, and shared read state work without Cursor being
installed. Re-import revives the existing managed root rather than duplicating
it; it refreshes the snapshot only while no provider continuation has been
created.

## Signing and Release

The builder configuration no longer hard-disables production signing. A release
preflight classifies each platform as signed or unsigned:

- no signing credentials: build and publish the documented unsigned artifacts;
- a complete credential set: enable signing and, on macOS, notarization;
- a partial credential set: stop before packaging with a precise missing-secret
  error.

The macOS ad-hoc `afterPack` repair remains for unsigned auto-update bundles.
Production Developer ID signing runs after that hook and replaces the ad-hoc
signature. Signed builds use hardened runtime and explicit entitlements. CI
verifies the final macOS TeamIdentifier/notarization status or Windows
Authenticode status before publishing.

No package ID, bundle ID, deep link, updater provider, release asset name, or
channel changes. Because `v0.8.37` already exists, the intended release is
`v0.8.38`, subject to the next-free-version check immediately before tagging.

## Cross-Surface Scope

### Desktop Electron

Cursor discovery, parsing, import UI, provenance labels, first-turn handoff, and
conditional desktop packaging are affected.

### React Native/iOS

No local Cursor filesystem access is added. Imported conversations arrive over
the existing backend contract and remain browsable, searchable, and continuable.
The client renders Cursor provenance supplied by the shared projection.

### Native Android

The same backend projection and continuation semantics apply. Android does not
open Cursor databases locally.

### Shared backend/API contract

Session summaries and stored conversation projections gain optional import
provenance and native-resume capability. Import accepts `cursor` as a source.
Older clients ignore the additive fields.

### Stored data and upgrades

An additive nullable `origin_source` column preserves all existing rows. Cursor
imports are copied into existing conversation/message tables. Upgrade and
rollback leave Cursor's source databases untouched; older Switchboard versions
continue to see the conversation as its runnable `agent_type`.

### Update channels and rollout

The stable desktop channel remains unchanged. Signing activation is
credential-driven, not feature-flagged. Release evidence distinguishes signed,
unsigned, hardware-verified, and unexercised checks.

## Error Handling

- Cursor database errors are isolated per store and logged without content.
- Unsupported records are skipped; unsupported stores remain visible as a
  diagnostic rather than crashing the inventory.
- Project matching is exact after URI/path normalization.
- Import is transactional and idempotent.
- Partial signing configuration blocks packaging before any artifact upload.
- Missing certificates never produce a claim that artifacts were signed.

## Verification

Implementation follows red-green-refactor. Focused tests cover legacy and
current Cursor schemas, project matching, malformed records, deterministic IDs,
idempotent import, provenance projection, context handoff, and signing-mode
classification. Existing launch-config and transcript-migration suites are run
as regression evidence.

After focused tests: run root typecheck and tests, mobile typecheck/tests, native
Android tests, the feature-parity validator, production build, and local macOS
packaging. Claude reviews the complete branch diff adversarially; confirmed
issues are fixed and all relevant gates rerun before versioning and release.

## Alternatives Rejected

### Legacy-only Cursor query

Rejected because current Cursor releases moved composer headers and bubble data
to global storage. It would appear to work only for old installations.

### Live virtual browsing

Rejected because it couples every render to Cursor's mutable SQLite files,
cannot work on mobile clients, and makes search/export behavior depend on another
application being installed and unlocked.

### Rewriting completed roadmap items

Rejected because the shipped launch-config and profile-switch designs already
cover the requested behavior. Regression verification and documentation repair
are safer and more accurate.
