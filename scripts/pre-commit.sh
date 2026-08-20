#!/bin/sh
# Switchboard pre-commit hook.
# Installed into .git/hooks/pre-commit by scripts/install-hooks.mjs (runs
# automatically on `npm install` via the `prepare` npm lifecycle).
#
# Steps, fail-fast:
#   1. Deslop-lint staged TS files (catches new `as any`, useless catches,
#      etc. - pre-existing violations are tracked separately via
#      `npm run lint:deslop`).
#   2. Run the test suite.
#
# Bypass for genuine emergencies: `git commit --no-verify`. Don't make a
# habit of it.

set -e

echo "==> deslop-lint staged files..."
npx --no-install lint-staged

echo "==> running tests..."
if node -e "const Database = require('better-sqlite3'); new Database(':memory:').close()" >/dev/null 2>&1; then
  npm test
else
  echo "better-sqlite3 is rebuilt for Electron; splitting tests by native runtime..."
  npx --no-install vitest run \
    --exclude tests/unit/durable-turn-acceptance.test.ts \
    --exclude tests/unit/turn-acceptance-store.test.ts
  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/vitest/vitest.mjs run \
    tests/unit/durable-turn-acceptance.test.ts \
    tests/unit/turn-acceptance-store.test.ts
fi

echo "All pre-commit checks passed."
