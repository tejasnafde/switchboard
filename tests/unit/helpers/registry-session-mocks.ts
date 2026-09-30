/**
 * Mocks for a test file that runs a real ProviderRegistry START_SESSION.
 * Import it before anything that loads the registry:
 *
 *   import './helpers/registry-session-mocks'
 *
 * A session start otherwise does real work none of those files test: the
 * first log line initialises the file logger (which prunes the log dir), the
 * notebook attach walks the cwd and starts a watcher there, and git runs for
 * the toplevel and the turn checkpoint. Under load that pushed the first test
 * of a file toward the 5 s timeout.
 */
import { vi } from 'vitest'

vi.mock('../../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../../src/main/notebooks/manager', () => ({
  notebookManager: {
    setPublisher: () => {}, attach: () => [], detach: () => {}, beginTurn: () => {},
    drainTurnEdits: () => [], explainsFileEdit: () => false,
  },
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      (args[args.length - 1] as (err: Error) => void)(new Error('git does not run in this test'))
    },
  }
})
