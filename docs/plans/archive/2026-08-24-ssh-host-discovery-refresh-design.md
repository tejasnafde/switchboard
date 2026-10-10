# SSH host discovery refresh

## Goal

Make every Add machine flow show a fresh, actionable set of machines. Already-saved machines must not compete with new candidates, and native Android must gain the SSH-config-backed IAP discovery already available on React Native/iOS.

## Interaction

Desktop rereads `~/.ssh/config` whenever Add machine opens. The primary list contains only hosts that can be added. Saved hosts move into a collapsed `Already added (N)` disclosure, preserving discoverability without cluttering the task. Loading and read failures never remove the manual form.

React Native/iOS and native Android query every ready Switchboard backend for `machines:list-iap-targets` whenever the IAP add flow is entered. They merge duplicates by normalized `project + zone + instance`, then remove targets already saved on that device. When discovery succeeds but every result is saved, the empty state says so explicitly instead of claiming nothing was discovered.

React Native/iOS retains its existing tap-to-add behavior. Android presents discovered targets above the existing IAP fields; selecting one fills name, project, zone, and instance while leaving the required backend token and Google-account checks in the existing form flow.

## Architecture and data flow

- Desktop keeps the existing `machines:list-ssh-hosts` IPC contract. `AddMachineModal` triggers a fresh load on mount and uses a pure partition helper for available and saved hosts.
- React Native/iOS keeps the existing `listIapTargets()` API and adds a pure selection policy that merges results and filters saved IAP connection configs.
- Native Android adds the existing channel constant, JSON decoder, and `SwitchboardRemoteClient` method. A small discovery coordinator fans out across ready client leases, ignores individual unavailable backends, rejects stale/superseded results, and returns a merged list to the pairing route.
- No backend wire shape, database schema, stored connection shape, credential handling, or migration changes.

## Failure and lifecycle behavior

Each opening starts a new discovery generation. Closing the screen/modal or starting a newer request prevents late results from replacing current state. Partial mobile success is useful: one unreachable backend does not hide targets returned by another. When no ready backend can answer, mobile retains manual entry and explains that discovery requires a connected desktop.

## Verification

Implementation follows red-green-refactor. Pure tests cover identity, partitioning, merging, saved-target filtering, partial failures, and stale completion. Component/integration tests cover loading, all-added, selection, and refresh-on-reopen states. The full desktop gate, React Native typecheck/tests, Android JVM/lint/assembly/android-test compilation, feature-parity validation, and an isolated Electron Playwright flow must pass. The E2E edits a temporary SSH config between modal openings and cleans every generated `sb-*` temp directory after the run.

## Product and release impact

- Desktop Electron: implemented UI refresh and host partitioning.
- React Native/iOS: implemented refreshed and filtered IAP discovery.
- Native Android: implemented discovery client, orchestration, and selection UI.
- Shared backend/API: existing endpoint reused without a contract change.
- Storage/migrations: not applicable; saved connection identity is read only.
- Rollout: desktop `0.8.44`, automatic iOS production OTA, and native Android `0.5.7` (`versionCode 9`) through the manual signed APK workflow. Automated, hardware, and unexercised verification are recorded separately in the feature-parity manifest and changelog.
