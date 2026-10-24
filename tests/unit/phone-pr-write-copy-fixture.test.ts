/**
 * tests/fixtures/phone-pr-write-copy.json is the phone write copy and limit
 * notes native Android keeps in PhonePrWrites.kt (checked by
 * PhonePrWritesTest). After changing PHONE_PR_WRITE_COPY or prTextLimitNote,
 * regenerate it with
 *
 *   SB_UPDATE_FIXTURES=1 npx vitest run tests/unit/phone-pr-write-copy-fixture.test.ts
 *
 * and update the Kotlin copy until its test passes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PHONE_PR_WRITE_COPY, prTextLimitNote } from '../../src/shared/pull-request-phone-writes'
import { PR_TEXT_MAX_CHARS } from '../../src/shared/pull-request-writes'

const FIXTURE = join(__dirname, '../fixtures/phone-pr-write-copy.json')

function fixture() {
  const lengths = [PR_TEXT_MAX_CHARS, PR_TEXT_MAX_CHARS + 1, 61_234, 1_250_000]
  return {
    copy: PHONE_PR_WRITE_COPY,
    maxChars: PR_TEXT_MAX_CHARS,
    limitNotes: (['github', 'bitbucket'] as const).flatMap((host) =>
      lengths.map((length) => ({ host, length, note: prTextLimitNote(host, length) })),
    ),
  }
}

describe('phone pull request write copy fixture', () => {
  it('matches PHONE_PR_WRITE_COPY and prTextLimitNote', () => {
    const expected = `${JSON.stringify(fixture(), null, 2)}\n`
    if (process.env.SB_UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, expected)
    expect(
      readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'),
      'tests/fixtures/phone-pr-write-copy.json is stale: run SB_UPDATE_FIXTURES=1 npx vitest run tests/unit/phone-pr-write-copy-fixture.test.ts',
    ).toBe(expected)
  })
})
