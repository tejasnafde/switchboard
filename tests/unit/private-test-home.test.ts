import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { userDataDir } from '../../src/main/runtime'
import { createMainLogger, flushLogsSync } from '../../src/main/logger'
import {
  isOwnedRunRoot,
  logFilesFromRun,
  PRIVATE_HOME_ENV_KEYS,
  resolveRealHome,
  restoreEnv,
  snapshotEnv,
} from '../setup/private-home'
import { startPrivateHome } from '../setup/global-private-home'

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

describe('startPrivateHome teardown', () => {
  const noLogs = (): [] => []
  const envNow = (): Record<string, string | undefined> => snapshotEnv(process.env, PRIVATE_HOME_ENV_KEYS)

  it('restores every variable it changed and removes its run root', () => {
    const before = envNow()
    const teardown = startPrivateHome({ readLogs: noLogs })
    const runRoot = process.env.SB_TEST_RUN_ROOT ?? ''
    expect(runRoot).not.toBe(before.SB_TEST_RUN_ROOT)
    expect(existsSync(runRoot)).toBe(true)
    teardown()
    expect(envNow()).toEqual(before)
    expect(existsSync(runRoot)).toBe(false)
  })

  it('keeps the real home when a second setup runs before the first is torn down', () => {
    const before = envNow()
    const first = startPrivateHome({ readLogs: noLogs })
    const afterFirst = envNow()
    const second = startPrivateHome({ readLogs: noLogs })
    expect(process.env.SB_TEST_REAL_HOME).toBe(realHome)
    second()
    expect(envNow()).toEqual(afterFirst)
    first()
    expect(envNow()).toEqual(before)
  })

  it('still cleans up and restores the env when inspecting the logs fails, and keeps the error', () => {
    const before = envNow()
    const teardown = startPrivateHome({
      readLogs: () => {
        throw new Error('EACCES: logs unreadable')
      },
    })
    const runRoot = process.env.SB_TEST_RUN_ROOT ?? ''
    expect(() => teardown()).toThrow('EACCES: logs unreadable')
    expect(existsSync(runRoot)).toBe(false)
    expect(envNow()).toEqual(before)
  })

  it('restores the env even when removing the run root fails, and keeps that error', () => {
    const before = envNow()
    let runRoot = ''
    const teardown = startPrivateHome({
      readLogs: noLogs,
      removeDir: (dir) => {
        runRoot = dir
        throw new Error('EBUSY: run root in use')
      },
    })
    expect(() => teardown()).toThrow('EBUSY: run root in use')
    expect(envNow()).toEqual(before)
    rmSync(runRoot, { recursive: true, force: true })
  })

  it('fails when a log file of this run appears in the real logs dir', () => {
    const teardown = startPrivateHome({
      readLogs: () => [{ name: `switchboard-2026-09-30-101010-${process.pid}.log`, mtimeMs: Date.now() + 1_000 }],
    })
    expect(() => teardown()).toThrow(/tests wrote 1 log file/)
  })
})

describe('env snapshot helpers', () => {
  it('restores set values and deletes keys that were unset', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/real' }
    const snapshot = snapshotEnv(env, ['HOME', 'SB_TEST_RUN_ROOT'])
    env.HOME = '/tmp/private'
    env.SB_TEST_RUN_ROOT = '/tmp/root'
    restoreEnv(env, snapshot)
    expect(env).toEqual({ HOME: '/real' })
  })

  it('prefers the recorded real home over the current, possibly private, one', () => {
    expect(resolveRealHome({ SB_TEST_REAL_HOME: '/Users/dev' }, '/tmp/sb-vitest-home-x/home')).toBe('/Users/dev')
    expect(resolveRealHome({}, '/Users/dev')).toBe('/Users/dev')
  })
})
