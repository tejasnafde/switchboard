import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { userDataDir } from '../../src/main/runtime'
import { createMainLogger, flushLogsSync } from '../../src/main/logger'
import { isOwnedRunRoot, logFilesFromRun } from '../setup/private-home'

const root = process.env.SB_TEST_RUN_ROOT ?? ''
const realHome = process.env.SB_TEST_REAL_HOME ?? ''
const realSwitchboard = join(realHome, '.switchboard')
const fileStartedAt = Date.now()

describe('vitest private home', () => {
  const savedDataDir = process.env.SWITCHBOARD_DATA_DIR
  afterEach(() => {
    process.env.SWITCHBOARD_DATA_DIR = savedDataDir
  })

  it('points the home and the data dir inside the run root, away from the real home', () => {
    expect(root).not.toBe('')
    expect(realHome).not.toBe('')
    expect(homedir().startsWith(root + sep)).toBe(true)
    expect(userDataDir().startsWith(root + sep)).toBe(true)
    expect(userDataDir().startsWith(realSwitchboard)).toBe(false)
  })

  it('writes the log file into the run root and not into the real ~/.switchboard/logs', () => {
    createMainLogger('test:private-home').info('private home probe')
    flushLogsSync()
    const own = (dir: string): string[] =>
      existsSync(dir)
        ? logFilesFromRun(
            readdirSync(dir).map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs })),
            new Set([process.pid]),
            fileStartedAt,
          )
        : []
    expect(own(join(userDataDir(), 'logs'))).toHaveLength(1)
    expect(own(join(realSwitchboard, 'logs'))).toEqual([])
  })

  it('refuses the home fallback when a test drops SWITCHBOARD_DATA_DIR', () => {
    delete process.env.SWITCHBOARD_DATA_DIR
    expect(() => userDataDir()).toThrow(/SWITCHBOARD_DATA_DIR/)
  })
})

describe('isOwnedRunRoot', () => {
  const tmp = tmpdir()
  it('accepts only a prefixed directory directly under the temp root', () => {
    expect(isOwnedRunRoot(join(tmp, 'sb-vitest-home-abc'), tmp)).toBe(true)
    expect(isOwnedRunRoot(tmp, tmp)).toBe(false)
    expect(isOwnedRunRoot(join(tmp, 'sb-ide-e2e-1'), tmp)).toBe(false)
    expect(isOwnedRunRoot(join(tmp, 'x', 'sb-vitest-home-abc'), tmp)).toBe(false)
    expect(isOwnedRunRoot(join(tmp, 'sb-vitest-home-abc', '..'), tmp)).toBe(false)
  })
})

describe('logFilesFromRun', () => {
  const since = 1_000
  it('matches the logger file name by trailing pid only', () => {
    const entries = [
      'switchboard-1970-01-01-000000-41.log',
      'switchboard-2026-09-30-101010-42.log',
      'switchboard-2026-09-30-101010-420.log',
      'other-42.log',
    ].map((name) => ({ name, mtimeMs: since }))
    expect(logFilesFromRun(entries, new Set([42, 41]), since)).toEqual([
      'switchboard-1970-01-01-000000-41.log',
      'switchboard-2026-09-30-101010-42.log',
    ])
  })

  it('ignores an older file that carries a reused pid', () => {
    const entries = [{ name: 'switchboard-2026-09-23-125337-42.log', mtimeMs: since - 1 }]
    expect(logFilesFromRun(entries, new Set([42]), since)).toEqual([])
  })
})
