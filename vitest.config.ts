import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Worker threads, not forked processes. The fork pool starts about 630
    // processes per run (one per test file), and on macOS launchservicesd
    // registers each one: measured at 100-190% CPU for the whole run on an
    // 8-core Mac, which no `nice` on the workers can lower. Threads measured
    // on 2026-10-17: same 6674 tests green in 73 s, launchservicesd median
    // 0.2%. Tests must not call process.chdir (threads cannot); none do.
    pool: 'threads',
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
