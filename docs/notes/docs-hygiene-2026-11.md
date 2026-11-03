# Documentation and repository audit, 2026-11-03

Audited `origin/main` at `9851af8c2db35cca1aa2c1457dae4d9439729092` in an
isolated worktree. The first-parent merge history for the last two weeks was
compared with [`docs/features.md`](../features.md). All PRs cited in the
inventory were read with `gh pr view` and their merge commits checked as
ancestors of that tree. Source code, not PR prose alone,
determines the behavior described here.

## Scope and verification

Desktop, iOS, Android, shared API, stored data and release packaging were all
scoped before editing. This batch changes docs and ignore rules only. It does
not change runtime behavior, flags, generated assets, migration, package identity,
signing or update channels. The sender-line manifest changes only its evidence
path. `docs/feature-parity/docs-hygiene-2026-11.json` records this scope.

Automated validation is recorded in the PR. No app, hardware, packaged upgrade,
store or release was exercised. Existing manifests retain their separate
hardware and unexercised records.

Test-only PR #509 replaces literal `/tmp` session fixtures with `os.tmpdir()`
and adds `tests/unit/no-tmp-session-cwd.test.ts`. It changes no shipped feature;
Android release PR #484 is superseded in source by #524. These are accounted
for separately from product additions.

## Manifest drift reported, not reclassified

The historical manifests below describe staged phone work that later code
partly or fully implemented. Their status and rollout meaning are unchanged in
this batch. Updating them needs a feature-specific audit of the remaining
controls and device verification, not a blanket status flip.

| Manifest | Evidence and remaining distinction |
|---|---|
| `reviews.json`, `reviews-split-waiting.json`, `reviews-list-reliability.json` | Both phones have a Reviews screen and grouping now: `apps/mobile/src/screens/ReviewsScreen.tsx`, `src/shared/pull-request-phone.ts`, Android `ui/reviews/ReviewsScreen.kt` and `domain/reviews/PhonePullRequests.kt`. The claims that neither phone reads PRs are stale. `phone-pull-requests.json` records the later work. |
| `reviews-to-chat.json` | Both phones have Work on PR and linked-chat behavior. See iOS `lib/pr-chat.ts`, `screens/PullRequestScreen.tsx` and Android `domain/reviews/WorkOnPr.kt`; `reviews-to-chat` still describes phone linking as future work. `phone-pull-requests.json` and `phone-approves-agent-pr-writes.json` cover later slices. |
| `reviews-hidden-repos.json` | The iOS Reviews screen reads `hiddenRepos` and offers unhide; both phone stores consume the list contract. The statement that there is no phone pull-request code is obsolete. This alone does not prove every desktop error-card action is exposed. |
| `reviews-write.json` | Phone Reply, Resolve, Comment and Review exist behind `pr_write_scope_v1` and the per-device `pr-write` grant, with device unlock. See `phone-pr-writes.json`, `src/shared/pull-request-phone-writes.ts` and iOS `components/PrWriteSheet.tsx`. The claim that all writes require admin is stale. Merge and other desktop-only actions must stay distinct. |
| `reviews-manage.json` | The “no Reviews screen” premise is obsolete; add/remove reviewer and close/decline still remain admin-scoped. Do not mark phone management implemented just because the tab exists. |
| `queue-and-steer.json` | Android has the queue toggle, wire methods and presentation now: `ui/thread/ThreadSessionPresentation.kt`, `ThreadScreen.kt`, `domain/thread/TurnDelivery.kt` and `data/remote/SwitchboardRemoteClient.kt`. Its staged explanation says the composer toggle is still to come. `queue-steer-correctness.json` and `composer-follow-ups.json` cover later behavior. |
| `worktree-creation-transaction.json` | Android has create/get/act RPC methods and worktree creation coordinators. The staged follow-up still names 0.5.7 while source is 0.5.25. Its on-device reconnect matrix is not proved by source presence, so staged status cannot safely become implemented from this audit. |
| `hub-children.json` | Its opening summary still says nothing reads the flag outside tests, followed by descriptions of the implemented launch, UI, messaging and settle paths. `provider-registry.ts`, `hub/hub-start.ts` and phone `HubChildrenRow.tsx` do read the rollout. Staged status is still appropriate: `HUB_CHILDREN_ENABLED` is false and phone child banners/settle remain unfinished. |

The off-by-default statuses for `hub-remote-children.json`,
`agent-visual-preview.json` and `phone-html-live-run.json` match the code.
`agent-secret-request.json` correctly distinguishes desktop entry from staged
phone entry, even though phones already show read-only cards. `snooze.json`,
`snooze-presets.json`, `settle.json` and `chat-details-popover.json` describe
implemented controls; capability checks are not evidence that a feature is off.

## Plan disposition

Moved only `2026-10-21-sender-line.md` into `docs/plans/archive/`, with its
contents intact. The runtime in `provider/sender-context.ts`, `shared/sender-line.ts`
and `terminal/dev-server-watch.ts`, plus the sender-line tests and manifest,
cover the plan's behavior. Updated its instruction and manifest references.

Retained the execution-root design: the backend transaction and desktop Follow
shipped, but existing-terminal reconciliation and phone Follow did not. Retained
the Android checklist for its unresolved device/upgrade evidence, while correcting
its retired package, version and self-updater claims. Retained store publishing:
repo procedures exist, but account-holder actions, store approval and configured
signing credentials are not established by a code audit.

## Generated phone assets

`apps/mobile/assets/visual-host/visual-host.html` is 3,466,068 bytes in the
audited tree. `node scripts/build-visual-host.mjs` bundles `src/visual-host/index.ts`,
shared visual/live-page rules and the diagram renderer with the root-installed
diagram and sanitizing dependencies. It also copies four live-page libraries
from `resources/sb-live/` to `apps/mobile/assets/live-libs/*.sblib`.

Consumers:

- iOS `components/ChatVisual.tsx` statically requires the HTML through
  `expo-asset`; Metro explicitly accepts `.html` and `.sblib`. `HtmlLiveFrame.tsx`
  statically requires the four library copies. Assets must exist before bundling.
- Android Gradle adds the same `assets/visual-host` folder to its assets.
  Live-page libraries on Android come directly from `resources/sb-live`.
- `tests/unit/visual-host-asset.test.ts` reads the HTML at module load, checks
  its input stamp, CSP and byte-for-byte library copies. It does not build them.
- Root CI/release unit tests, Android CI/releases and EAS/OTA exports currently
  rely on the committed files. Neither the root scripts nor the mobile package
  installs an asset-generation lifecycle hook. EAS profiles define no generation
  hook; the OTA workflow installs both dependency trees and publishes from source.

Proposal: in a separate PR, generate these assets after the root locked install
and before root tests, Android asset merge, Metro/EAS build and OTA export. Add
an EAS hook that can reach the repo root and its dev dependencies, and document
the same preparation for local Android-only builds. Validate a clean checkout,
an EAS source upload and an OTA export before removing the tracked HTML and
library copies. Keep CSP, dependency versions, the input stamp and byte checks.

Risks: a CI-only generator leaves EAS and local Gradle builds without assets;
Metro's static require fails before startup; an EAS archive may omit root input
files or dev dependencies; a stale generated file can pass local work while
failing a clean build; generated library changes must still reach the OTA lane.
Do not change the build in this docs batch.

## Changelog

`CHANGELOG.md` is 371,339 bytes in the audited tree. Repository searches of
scripts, workflows, attributes and documentation found no executable release
consumer extracting entries from it: `release.yml` supplies a short release-note
body directly, and APK notes are generated in `mobile-release.yml`. The parity
validator treats it as docs; many historical manifests cite it as evidence.
The parser test also refers readers to a dated entry. No merge-changelog driver
is configured in this checkout, and no `merge-changelog` executable was found
on PATH. External merge tooling is not established by those negative checks.

Proposal: keep Unreleased and the latest few releases in `CHANGELOG.md`, move
older entries without rewriting them to `docs/changelog/<year>.md` (or a legacy
file for undated entries), and leave an index in the root file. Before that
change, confirm the operator's external merge-changelog tooling and update
historical evidence and deep links to the archived entries. Keep the split
forward-only. This batch leaves the changelog intact because source searches
alone do not establish compatibility with that external workflow.

## Other tracked files and ignore rules

The four `.sblib` copies are generated duplicates, totaling about 1.2 MB, and
are candidates for the same future generation step. They are required by the
current iOS build and are retained. Vendored sources, lockfiles, fonts, the
Gradle wrapper, screenshot baselines, store graphics and tour videos are
intentional inputs or fixtures, not disposable output. Tour videos are bundled
from `videos/dist/`; the ignore exception must stay. No tracked logs, local env
files, signing keys, app packages, coverage or e2e output were found by the
tracked-path audit.

Added ignores for logs, process dumps, env variants (with sample/template
exceptions), app bundles and mobile packages, native build caches and generated
iOS/Android projects, and the known e2e scratch prefixes. These additions do not
untrack any file or rewrite history. E2E folders created outside the checkout
still require the cleanup in `AGENTS.md`.
