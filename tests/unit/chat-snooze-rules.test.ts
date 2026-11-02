/** Snooze rules against the shared fixture (the Kotlin port runs the same file). */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NOT_SNOOZED,
  checkWakeTime,
  isSnoozed,
  isWoke,
  parsePresetList,
  parsePresetSpec,
  prWakeSummary,
  type PrMark,
  type PrReading,
  pickPreset,
  resolvePresets,
  shouldWakeOn,
  validateCustomWake,
  wakeLabel,
  type InboxEvent,
  type SnoozePresetSpec,
} from '../../src/shared/chat-snooze'

const cases = JSON.parse(readFileSync(join(__dirname, '../fixtures/chat-snooze-cases.json'), 'utf8'))

/** `YYYY-MM-DDTHH:MM[:SS]` as local wall time. */
function local(text: string): Date {
  const [d, t] = text.split('T')
  const [y, mo, day] = d.split('-').map(Number)
  const [h, mi, s = 0] = t.split(':').map(Number)
  return new Date(y, mo - 1, day, h, mi, s)
}

function wall(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

describe('resolvePresets', () => {
  for (const c of cases.presets) {
    it(c.name, () => {
      const options = resolvePresets(local(c.now), c.specs as SnoozePresetSpec[] | undefined)
      expect(options.map((o) => [o.label, wall(o.at)])).toEqual(c.expect)
    })
  }
})

describe('pickPreset', () => {
  for (const c of cases.pick) {
    it(c.name, () => {
      const option = resolvePresets(local(c.shownAt)).find((o) => o.label === c.label)!
      const picked = pickPreset(option, local(c.clickAt).getTime())
      expect(picked.ok ? wall(picked.at) : picked.reason).toBe(c.expect)
    })
  }
})

describe('wakeLabel', () => {
  for (const c of cases.wakeLabel) {
    it(`${c.until ?? c.pr} from ${c.now}`, () => {
      expect(wakeLabel(c.until ? local(c.until).getTime() : null, c.pr, local(c.now))).toBe(c.expect)
    })
  }
})

describe('validateCustomWake', () => {
  for (const c of cases.customWake) {
    it(`${c.date.join('-')} ${c.clock}`, () => {
      const [year, month, day] = c.date
      const out = validateCustomWake({ year, month, day }, c.clock, local(c.now).getTime())
      expect(out.result).toBe(c.expect)
      if (c.at) expect(wall(out.at!)).toBe(c.at)
    })
  }

  // The zone is fixed per process, so each zone runs the rules file in a child with TZ set.
  for (const zone of cases.customWakeDst) {
    it(`in ${zone.zone}: refuses a time a DST change skips and takes the first of a repeated one`, () => {
      const script = `
        import { validateCustomWake } from ${JSON.stringify(pathToFileURL(join(__dirname, '../../src/shared/chat-snooze.ts')).href)}
        const cases = ${JSON.stringify(zone.cases)}
        console.log(JSON.stringify(cases.map((c) => {
          const [year, month, day] = c.date
          return validateCustomWake({ year, month, day }, c.clock, ${zone.now})
        })))`
      const out = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
        env: { ...process.env, TZ: zone.zone, NODE_NO_WARNINGS: '1' },
        encoding: 'utf8',
      })
      const results = JSON.parse(out) as Array<{ result: string; at: number | null }>
      expect(results.map((r) => r.result)).toEqual(zone.cases.map((c: { expect: string }) => c.expect))
      zone.cases.forEach((c: { epochMs?: number }, i: number) => {
        if (c.epochMs) expect(results[i].at).toBe(c.epochMs)
      })
    })
  }

  it('takes the earlier instant of a repeated autumn time (first occurrence, summer offset)', () => {
    const [ny] = cases.customWakeDst
    const repeated = ny.cases.find((c: { clock: string; date: number[] }) => c.date[1] === 11)
    // 01:30 EDT is 05:30 UTC; the second 01:30 (EST) would be an hour later.
    expect(new Date(repeated.epochMs).toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })
})

describe('shouldWakeOn', () => {
  for (const c of cases.shouldWakeOn) {
    it(c.name, () => {
      expect(shouldWakeOn(c.event as InboxEvent, { ...NOT_SNOOZED, ...c.state })).toBe(c.expect)
    })
  }
})

describe('parsePresetSpec', () => {
  for (const c of cases.parsePreset) {
    it(`${c.raw.label} ${c.ok ? 'is' : 'is not'} a preset`, () => {
      expect(parsePresetSpec(c.raw) !== null).toBe(c.ok)
    })
  }

  it('keeps the usable stored presets, at most 8, and falls back to the defaults', () => {
    const lunch = { label: 'Lunch', kind: 'time', dayOffset: 0, hour: 13, minute: 0 }
    expect(parsePresetList(Array(10).fill(lunch))).toHaveLength(8)
    expect(parsePresetList([{ label: '' }])[0].label).toBe('Later today')
    expect(parsePresetList('nonsense')).toHaveLength(4)
  })
})

describe('state', () => {
  it('is snoozed while snoozedAt is set, and woke only when not snoozed', () => {
    expect(isSnoozed({ snoozedAt: 1 })).toBe(true)
    expect(isWoke({ snoozedAt: 1, wokeAt: 2 })).toBe(false)
    expect(isWoke({ snoozedAt: null, wokeAt: 2 })).toBe(true)
  })

  it('accepts a wake time up to a minute late and up to a year ahead', () => {
    const now = 10_000_000
    expect(checkWakeTime(now - 60_000, now)).toBe('ok')
    expect(checkWakeTime(now - 60_001, now)).toBe('past')
    expect(checkWakeTime(now + 366 * 24 * 3600_000, now)).toBe('too_far')
    expect(checkWakeTime(Number.NaN, now)).toBe('past')
  })
})

describe('prWakeSummary', () => {
  for (const c of cases.prWake) {
    it(c.name, () => {
      expect(prWakeSummary(c.mark as PrMark, c.reading as PrReading)).toBe(c.expect)
    })
  }
})
