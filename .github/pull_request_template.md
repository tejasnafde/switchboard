## Outcome

<!-- Lead with the user-visible behavior and why it changed. -->

## Cross-surface scope

Feature parity manifest: `docs/feature-parity/<feature>.json`

- [ ] Desktop Electron is implemented, explicitly N/A, or feature-flagged for a named release.
- [ ] React Native/iOS is implemented, explicitly N/A, or feature-flagged for a named release.
- [ ] Native Android is implemented, explicitly N/A, or feature-flagged for a named release.
- [ ] Shared backend/API compatibility is covered.
- [ ] Stored data, migrations, and upgrade compatibility are covered.
- [ ] Update channels, packaging, and rollout are covered.

## Verification

- Automated:
- Hardware/smoke-tested:
- Not exercised:

## Release safety

- [ ] Package IDs, signing identities, deep links, API contracts, and update channels are unchanged or deliberately migrated.
- [ ] Upgrade behavior and data preservation were tested when storage, identity, signing, or updater code changed.
- [ ] Any staged surface is unreachable without the named feature flag and has a follow-up release in the manifest.
