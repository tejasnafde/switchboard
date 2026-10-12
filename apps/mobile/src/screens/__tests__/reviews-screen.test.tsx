/**
 * The Reviews tab: sections in the desktop's groups, chips and the badge
 * counting Needs you, a host-wide error card, and the empty state. The PRs
 * are the shared fixture's (`tests/fixtures/phone-pr-cases.json`).
 */
import React from 'react'
import { act } from 'react-test-renderer'
import type { PrListData, PrSummary } from '@shared/pull-requests'
import ReviewsScreen from '../ReviewsScreen'
import { renderComponent } from '../../test/render'
import { useReviewsStore } from '../../stores/reviews'
import { usePrefsStore } from '../../stores/prefs'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cases = require('../../../../../tests/fixtures/phone-pr-cases.json') as {
  now: number
  prs: Record<string, PrSummary>
  hidden: string[]
}

jest.mock('@react-navigation/native', () => {
  const { useEffect } = jest.requireActual('react')
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

let mockList: PrListData
jest.mock('../../stores/connections', () => ({
  getClient: () => ({
    listPullRequests: async () => ({ ok: true, data: mockList }),
    unhidePullRequestRepos: async () => ({ ok: true }),
  }),
}))

const navigation = { replace: jest.fn(), navigate: jest.fn() }
const route = { params: { connectionId: 'conn', label: 'MacBook Pro' } }

function list(over: Partial<PrListData> = {}): PrListData {
  return {
    prs: Object.values(cases.prs),
    sources: [{ repo: { host: 'github', owner: 'geoiq', name: 'switchboard' }, projectPaths: [], error: null }],
    unsupportedProjects: [],
    fetchedAt: cases.now,
    hidden: cases.hidden,
    ...over,
  }
}

async function renderScreen(data: PrListData) {
  mockList = data
  useReviewsStore.setState({ byConnection: {} })
  usePrefsStore.setState({ prFilters: {} })
  jest.spyOn(Date, 'now').mockReturnValue(cases.now)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = renderComponent(<ReviewsScreen navigation={navigation as any} route={route as any} />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return view
}

afterEach(() => jest.restoreAllMocks())

describe('ReviewsScreen', () => {
  it('groups like the desktop, counts Needs you on the chip and the tab, and opens a row', async () => {
    const view = await renderScreen(list())
    const texts = view.texts()
    // The list renders its first rows only; the later groups are below the fold.
    expect(texts).toEqual(expect.arrayContaining(['MacBook Pro · 7 open', 'NEEDS YOU', 'READY TO MERGE']))
    expect(texts).toContain('Needs you · 2')
    expect(texts).toContain('Retry uploads when the signed URL expires')
    expect(
      view.root.findByProps({ testID: 'reviews-badge' }).findByType(require('react-native').Text).props.children,
    ).toBe(2)
    act(() => view.root.findByProps({ testID: 'pr-row-1482' }).props.onPress())
    expect(navigation.navigate).toHaveBeenCalledWith('PullRequest', {
      connectionId: 'conn',
      ref: { host: 'github', owner: 'geoiq', name: 'switchboard', number: 1482 },
      title: 'Retry uploads when the signed URL expires',
    })
  })

  it('narrows to Needs you from its chip', async () => {
    const view = await renderScreen(list())
    const chip = view.root.findAll(
      (n) =>
        n.props.accessibilityRole === 'button' &&
        n.props.onPress &&
        n.findAll((c) => c.props.children === 'Needs you · 2').length > 0,
    )
    await act(async () => {
      chip[0].props.onPress()
      await Promise.resolve()
    })
    expect(view.texts()).not.toContain('READY TO MERGE')
    expect(view.texts()).toContain('NEEDS YOU')
  })

  it('shows one card for a host that failed, and the other host rows', async () => {
    const error = {
      kind: 'token_rejected' as const,
      host: 'github' as const,
      message: "The desktop's gh is signed out.",
    }
    const view = await renderScreen(
      list({
        prs: [cases.prs.askedBb],
        sources: [
          { repo: { host: 'github', owner: 'geoiq', name: 'switchboard' }, projectPaths: [], error },
          { repo: { host: 'bitbucket', owner: 'geoiq', name: 'bb-sync' }, projectPaths: [], error: null },
        ],
      }),
    )
    expect(view.texts()).toEqual(
      expect.arrayContaining([
        "Couldn't read GitHub",
        "The desktop's gh is signed out.",
        'MacBook Pro · showing Bitbucket only',
      ]),
    )
    expect(view.root.findAllByProps({ testID: 'pr-row-605' }).length).toBeGreaterThan(0)
  })

  it('says nothing involves you when no pull request is listed', async () => {
    const view = await renderScreen(list({ prs: [] }))
    expect(view.texts()).toContain('Nothing open that involves you')
    expect(view.texts()).toContain('MacBook Pro · nothing open')
  })
})
