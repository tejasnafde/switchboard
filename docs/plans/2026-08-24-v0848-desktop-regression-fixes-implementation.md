# v0.8.48 Desktop regression fixes implementation plan

1. Add failing unit coverage for split-only chat focus presentation.
2. Add failing unit coverage for quit lifecycle state, deferred exactly-once quit retry, and source-level activation guards.
3. Implement the minimal renderer and main-process changes required by those tests.
4. Update the dual-chat parity manifest and add a quit/reopen parity manifest covering every product surface.
5. Bump Desktop to v0.8.48 and add release notes without changing mobile versions or shared contracts.
6. Run targeted tests, full typecheck/tests, feature-parity validation, gated packaging, smoke tests, and isolated v0.8.35/v0.8.47 packaged upgrades.
7. Review the final diff, create an immutable v0.8.48 tag, publish the desktop release, and verify the public assets/update feed before asking the user to update.
