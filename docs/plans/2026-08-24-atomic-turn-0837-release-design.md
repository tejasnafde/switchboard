# Atomic turn 0.8.37 release design

## Scope

Release the atomic user-turn delivery fix as Desktop/backend version 0.8.37. Fast-forward `main` from the isolated `codex/atomic-turn-submission` branch so the dirty primary checkout remains untouched. The main-branch push may publish the existing React Native iOS OTA because the branch contains the paired outbox compatibility changes.

Native Android remains at 0.5.5. The backend retains the legacy origin-bearing positional wire path, and the Android 0.5.5 outbox already treats origin conflicts, invalid image data, and the 3 MiB limit as terminal while preserving private attachments. Publishing Android 0.5.6 is excluded because the required production-signed physical-device upgrade verification was not performed.

## Release sequence

1. Add a user-facing 0.8.37 changelog entry covering atomic acceptance, exact-origin retries, rejected attachment recovery, mixed-version compatibility, and verification evidence.
2. Re-run typecheck, the full unit suite, feature-parity validation, production build, packaged-main smoke, React Native tests, and Android unit tests.
3. Use `npm version patch` so `package.json`, `package-lock.json`, the version commit, and annotated `v0.8.37` tag remain atomic.
4. Verify the tagged tree and fast-forward `origin/main` to it without changing the primary checkout, then push the tag.
5. Monitor the tag-driven Release workflow until its gate, macOS/Windows packages, and six-asset verifier pass. Monitor the main-push Mobile OTA and native Android CI workflows separately.

## Failure handling

Do not push a tag if a local gate fails or if `origin/main` moves away from the known base. After publication, do not rewrite or delete the release tag. A failed packaging matrix produces a partial release; follow the repository operator guide and rerun only the failed GitHub Actions jobs, which upload by stable asset name. If the iOS OTA job fails, leave Desktop compatibility intact and report the failed channel rather than publishing an unverified replacement.

## Acceptance

The release is complete only when GitHub marks the `v0.8.37` Release workflow green, all required Desktop/update assets exist with 0.8.37 manifests, the iOS OTA workflow succeeds, native Android CI succeeds without publishing an APK, and the release page identifies 0.8.37 as latest. Physical iOS and Android delivery recovery remain recorded as unexercised in the feature-parity manifest.
