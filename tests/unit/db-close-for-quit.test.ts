import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, getSetting, reopenDbAfterAbortedQuit, setSetting } from '../../src/main/db/database'

const previousDataDir = process.env.SWITCHBOARD_DATA_DIR
const root = mkdtempSync(join(tmpdir(), 'sb-db-quit-'))
process.env.SWITCHBOARD_DATA_DIR = root

afterAll(() => {
  // Windows cannot unlink an open database file.
  closeDb()
  if (previousDataDir === undefined) delete process.env.SWITCHBOARD_DATA_DIR
  else process.env.SWITCHBOARD_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

describe('closeDb', () => {
  it('reopens lazily after an ordinary close', () => {
    setSetting('quit-test', 'a')
    closeDb()
    expect(getSetting('quit-test')).toBe('a')
  })

  it('refuses to reopen after the quit close, and closing again is a no-op', () => {
    getDb()
    closeDb({ forQuit: true })
    expect(() => getDb()).toThrow(/quitting/)
    expect(() => setSetting('quit-test', 'b')).toThrow(/quitting/)
    expect(() => closeDb({ forQuit: true })).not.toThrow()
    expect(() => closeDb()).not.toThrow()
  })

  it('reopens again once an aborted quit clears the latch', () => {
    closeDb({ forQuit: true })
    reopenDbAfterAbortedQuit()
    expect(getSetting('quit-test')).toBe('a')
  })
})
