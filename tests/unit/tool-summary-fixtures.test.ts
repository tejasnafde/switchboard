/**
 * Cross-surface ground truth for tool-call summaries. Every case here is
 * also read by the native Android unit test
 * (apps/android/app/src/test/java/app/switchboard/mobile/ui/thread/ToolSummaryFixturesTest.kt)
 * from the same file, so desktop/mobile (this test) and native Android are
 * checked against one source of truth instead of three copies drifting
 * apart. A case marked `"android": false` is a documented, intentional
 * divergence - see the `note` field on that case - and is skipped here too,
 * since this file exists to confirm what DOES match, not to re-litigate
 * what does not.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { summarizeTool } from '../../src/shared/tool-summary'

interface ToolSummaryCase {
  id: string
  toolName: string
  input: unknown
  expected: { label: string; detail: string }
  android?: boolean
  note?: string
}

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(here, '../fixtures/tool-summary-cases.json')
const cases: ToolSummaryCase[] = JSON.parse(readFileSync(fixturePath, 'utf8'))

describe('tool-summary-cases fixture', () => {
  it('is non-empty and every id is unique', () => {
    expect(cases.length).toBeGreaterThan(0)
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
  })

  it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, testCase) => {
    const summary = summarizeTool(testCase.toolName, testCase.input)
    expect({ label: summary.title, detail: summary.detail }).toEqual(testCase.expected)
  })
})
