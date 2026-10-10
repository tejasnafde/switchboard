import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // A throwaway home + SWITCHBOARD_DATA_DIR per run, so tests never write
    // into the real ~/.switchboard (logs, db, shell, worktrees).
    globalSetup: ['tests/setup/global-private-home.ts'],
    setupFiles: ['tests/setup/record-worker-pid.ts'],
    // ponytail: one global value. The Windows runner is slow at spawning git, and
    // the worktree tests (fork-worktree-request, worktree-creation-git-adapter)
    // hit the 5s default there. Raise it per file if one test ever needs more.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    // `npm run test:coverage` only; no threshold gate. For finding what a
    // refactor is about to touch without a test, e.g. before splitting
    // provider-registry.ts. Report: coverage/index.html.
    coverage: {
      provider: 'v8',
      include: ['src/**', 'apps/mobile/src/lib/**'],
      reporter: ['text-summary', 'html'],
      reportOnFailure: true,
    },
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
    },
  },
})
