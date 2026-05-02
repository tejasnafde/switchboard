#!/bin/sh
# Switchboard pre-commit hook.
# Installed into .git/hooks/pre-commit by scripts/install-hooks.mjs (runs
# automatically on `npm install` via the `prepare` npm lifecycle).
#
# Steps, fail-fast:
#   1. Deslop-lint staged TS files (catches new `as any`, useless catches,
#      etc. — pre-existing violations are tracked separately via
#      `npm run lint:deslop`).
#   2. Run the test suite.
#
# Bypass for genuine emergencies: `git commit --no-verify`. Don't make a
# habit of it.

set -e

echo "==> deslop-lint staged files..."
npx --no-install lint-staged

echo "==> running tests..."
npm test

echo "All pre-commit checks passed."
