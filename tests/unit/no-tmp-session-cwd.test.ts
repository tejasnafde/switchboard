/**
 * START_SESSION refuses a cwd that does not exist, and Windows has no /tmp:
 * a registry test that starts a session in '/tmp' passes there only when an
 * earlier test happened to create the folder. Start sessions in tmpdir().
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const START_IN_TMP = /START_SESSION,\s*\{[^}]*cwd:\s*'\/tmp'/

describe('registry tests', () => {
  it("never start a session in the literal '/tmp'", () => {
    const dir = __dirname
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .filter((f) => START_IN_TMP.test(readFileSync(join(dir, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
