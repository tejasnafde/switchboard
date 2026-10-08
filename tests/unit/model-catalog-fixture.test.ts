/**
 * tests/fixtures/model-catalog.json is the pre-session model catalog the
 * Android app copies (NewSessionDecisions.kt, checked against the same file by
 * NewSessionDecisionsCatalogFixtureTest). This keeps the file equal to
 * src/shared/models.ts. After changing a catalog, regenerate it with
 *
 *   SB_UPDATE_FIXTURES=1 npx vitest run tests/unit/model-catalog-fixture.test.ts
 *
 * and update the Kotlin copy until its test passes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { modelsForAgent } from '../../src/shared/models'

const FIXTURE = join(__dirname, '../fixtures/model-catalog.json')

describe('model catalog fixture', () => {
  it('matches src/shared/models.ts', () => {
    const catalog = Object.fromEntries((['claude-code', 'codex', 'opencode'] as const).map((agent) => [
      agent,
      modelsForAgent(agent).map(({ id, label, tier }) => ({ id, label, tier })),
    ]))
    const expected = `${JSON.stringify(catalog, null, 2)}\n`
    if (process.env.SB_UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, expected)
    expect(
      // A Windows checkout may hold CRLF line endings; compare the content, not the line ends.
      readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'),
      'tests/fixtures/model-catalog.json is stale: run SB_UPDATE_FIXTURES=1 npx vitest run tests/unit/model-catalog-fixture.test.ts',
    ).toBe(expected)
  })
})
