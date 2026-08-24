# v0.8.49 Desktop regression fixes implementation plan

1. Add failing unit coverage for split-only chat focus presentation.
2. Add failing unit coverage for quit lifecycle state, deferred exactly-once quit retry, and source-level activation guards.
3. Implement the minimal renderer and main-process changes required by those tests.
4. Reproduce the remote-history overlap with tall dynamically measured turns, then replace smooth append-follow with an instant end-aligned scroll.
5. Update the dual-chat parity manifest and add quit/reopen and transcript-layout parity manifests covering every product surface.
6. Bump Desktop to v0.8.49 and add release notes without changing mobile versions or shared contracts. The v0.8.48 tag remains unpublished after its Windows release-gate timeout.
7. Run targeted tests, full typecheck/tests, feature-parity validation, gated packaging, smoke tests, and isolated v0.8.35/v0.8.47 packaged upgrades.
8. Review the final diff, create an immutable v0.8.49 tag, publish the desktop release, and verify the public assets/update feed before asking the user to update.
