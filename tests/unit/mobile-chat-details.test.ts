import { describe, expect, it } from 'vitest'
import {
  barAccessibilityLabel,
  branchValue,
  changesValue,
  prValue,
  usageBars,
} from '../../apps/mobile/src/lib/chat-details'
import { colors } from '../../apps/mobile/src/theme'
import type { PrLink } from '../../src/shared/pull-request-links'
import type { PrListData, PrSummary } from '../../src/shared/pull-requests'
import type { ProviderUsage } from '../../src/shared/provider-usage'
import { contrastRatio } from './helpers/contrast'

const ref = (number: number) => ({ host: 'github' as const, owner: 'acme', name: 'app', number })
const link = (number: number, linkedAt: number, state?: PrLink['state']): PrLink => ({
  ref: ref(number),
  source: 'auto',
  linkedAt,
  state,
})
const summary = (number: number, checks: Partial<PrSummary['checks']>, createdAt = 0): PrSummary =>
  ({
    ref: ref(number),
    title: `PR ${number}`,
    state: 'open',
    createdAt,
    checks: { state: 'none', total: 0, passed: 0, failed: 0, pending: 0, ...checks },
  }) as PrSummary
const list = (...prs: PrSummary[]): PrListData => ({ prs, fetchedAt: 10 }) as PrListData

describe('chat details sheet rows', () => {
  it('shows the branch, a detached HEAD, None for a failed read and an ellipsis while reading', () => {
    expect(branchValue({ ok: true, branch: 'feat/x' })).toEqual({ text: 'feat/x' })
    expect(branchValue({ ok: true, branch: null })).toEqual({ text: 'Detached HEAD' })
    expect(branchValue({ ok: false, error: 'not a repo' })).toEqual({ text: 'None', muted: true })
    expect(branchValue(undefined)).toEqual({ text: '…', muted: true })
  })

  it('shows lines added and removed, and No changes at zero', () => {
    expect(changesValue({ ok: true, added: 12, removed: 3 })).toEqual({ added: 12, removed: 3 })
    expect(changesValue({ ok: true, added: 0, removed: 0 })).toEqual({ text: 'No changes', muted: true })
    expect(changesValue({ ok: false, error: 'x' })).toEqual({ text: 'None', muted: true })
  })

  it('picks the first open PR before a newer merged one, with failing checks marked bad', () => {
    const pr = prValue([link(7, 50, 'merged'), link(5, 10)], list(summary(5, { state: 'failure', failed: 2 })))
    expect(pr).toEqual({ title: 'PR 5', detail: [{ text: '#5' }, { text: '2 checks failed', bad: true }] })
  })

  it('falls back to the newest link and its stored state, with the repository as the title', () => {
    expect(prValue([link(3, 10, 'closed'), link(4, 20, 'merged')], null)).toEqual({
      title: 'acme/app',
      detail: [{ text: '#4' }, { text: 'merged' }],
    })
    expect(prValue([], null)).toBeNull()
  })

  it('says checks running and one check failed', () => {
    expect(prValue([link(5, 1)], list(summary(5, { state: 'pending' })))?.detail[1]).toEqual({
      text: 'checks running',
    })
    expect(prValue([link(5, 1)], list(summary(5, { state: 'failure', failed: 1 })))?.detail[1]).toEqual({
      text: '1 check failed',
      bad: true,
    })
  })

  it('builds the three bars with percent left and tones, Unavailable and reading', () => {
    const usage = {
      status: 'ok',
      windows: [
        { kind: 'weekly', usedPercent: 85 },
        { kind: 'session', usedPercent: 91 },
      ],
    } as ProviderUsage
    const [weekly, session, context] = usageBars(usage, false, 40)
    expect(weekly).toMatchObject({ label: 'Weekly', left: 15, used: 85, tone: 'warning' })
    expect(session).toMatchObject({ label: '5-hour session', left: 9, tone: 'error' })
    expect(context).toMatchObject({ label: 'Context', left: 60, tone: 'neutral' })

    const failed = usageBars({ status: 'unsupported', windows: [] } as unknown as ProviderUsage, false, null)
    expect(failed.map(barAccessibilityLabel)).toEqual([
      'Weekly, unavailable',
      '5-hour session, unavailable',
      'Context, unavailable',
    ])
    expect(usageBars(undefined, true, null).map((b) => b.pending)).toEqual([true, true, false])
  })

  it.each([
    [90, 10, 'error'],
    [89, 11, 'warning'],
    [80, 20, 'warning'],
    [79, 21, 'neutral'],
  ])('turns a bar at %i%% used (%i%% left) %s', (used, left, tone) => {
    expect(usageBars(undefined, false, used)[2]).toMatchObject({ left, tone })
  })
})

describe('chat details sheet colours', () => {
  // The phone has one dark theme; the sheet sits on surfaceRaised.
  it.each([
    ['text', colors.text],
    ['textDim', colors.textDim],
    ['green', colors.green],
    ['amber', colors.amber],
    ['red', colors.red],
  ])('%s reads at 4.5:1 or better on the sheet', (_, colour) => {
    expect(contrastRatio(colour, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5)
  })
})
