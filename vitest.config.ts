import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // ponytail: one global value. The Windows runner is slow at spawning git, and
    // the worktree tests (fork-worktree-request, worktree-creation-git-adapter)
    // hit the 5s default there. Raise it per file if one test ever needs more.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
    },
  },
})
