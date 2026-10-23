import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import {
  AUTO_RESUME_AFTER_LIMIT_SETTING,
  autoResumeAfterLimitOn,
  fireChecks,
  LIMIT_AUTO_RESUME_LABS_SETTING,
  limitAutoResumeEnabled,
  limitResumeTurn,
  limitState,
  limitStateDetail,
  limitStateText,
  nextStreak,
  shouldArm,
} from '../../src/shared/limit-resume'

const here = dirname(fileURLToPath(import.meta.url))
const read = (name: string) => JSON.parse(readFileSync(resolve(here, `../fixtures/${name}`), 'utf8'))
const cases = read('limit-resume-cases.json')

describe('limit resume rules (tests/fixtures/limit-resume-cases.json)', () => {
  it.each(cases.limitState)('limitState: $name', ({ input, expected }) => {
    expect(limitState(input.limited, input.row)).toEqual(expected)
  })
  it.each(cases.shouldArm)('shouldArm: $name', ({ input, expected }) => {
    expect(shouldArm(input)).toEqual(expected)
  })
  it.each(cases.fireChecks)('fireChecks: $name', ({ input, expected }) => {
    expect(fireChecks(input)).toEqual(expected)
  })
  it.each(cases.nextStreak)('nextStreak: $name', ({ input, expected }) => {
    expect(nextStreak(input)).toEqual(expected)
  })
  // The phones' Limited rows port these lines; `time` is what the clock formatter returns.
  it.each(cases.limitStateText)('limitStateText and limitStateDetail: $name', ({ input, expected }) => {
    expect(limitStateText(input.state, () => input.time)).toBe(expected.title)
    expect(limitStateDetail(input.state)).toBe(expected.detail)
  })
})

describe('limit classification cases', () => {
  // The adapters classify these from PR 2 on; here the file itself is checked.
  const { cases: classification } = read('limit-classification-cases.json')
  it('every case is named once and expects a known class', () => {
    const names = classification.map((c: { name: string }) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const c of classification) {
      expect(['usage_limit', 'context_full', 'other']).toContain(c.expected.limitClass)
      expect(c.events.length).toBeGreaterThan(0)
    }
  })
})

describe('limitAutoResumeEnabled and the setting', () => {
  const none = () => null
  it('is off by default', () => {
    expect(limitAutoResumeEnabled({}, none)).toBe(false)
  })
  it('is on with SB_LIMIT_AUTO_RESUME=1', () => {
    expect(limitAutoResumeEnabled({ SB_LIMIT_AUTO_RESUME: '1' }, none)).toBe(true)
  })
  it('is on with the labs setting', () => {
    expect(limitAutoResumeEnabled({}, (k) => (k === LIMIT_AUTO_RESUME_LABS_SETTING ? 'true' : null))).toBe(true)
  })
  it('the per-user switch is on unless set to false', () => {
    expect(autoResumeAfterLimitOn(none)).toBe(true)
    expect(autoResumeAfterLimitOn((k) => (k === AUTO_RESUME_AFTER_LIMIT_SETTING ? 'false' : null))).toBe(false)
  })
  it('wraps the resume turn', () => {
    expect(limitResumeTurn()).toBe(
      '<switchboard-limit-resume>\nUsage limit reset. Continue the task where you left off.\n</switchboard-limit-resume>',
    )
  })
})
