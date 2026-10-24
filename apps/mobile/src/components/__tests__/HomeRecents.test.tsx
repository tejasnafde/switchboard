/**
 * What Home > Recents renders. The ordering and status rules are tested in
 * tests/unit/mobile-home-recents.test.ts.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { RecentsList } from '../HomeRecents'
import { renderComponent } from '../../test/render'
import type { HomeRecentRow, HomeRecentsPage } from '../../lib/home-recents'

function row(patch: Partial<HomeRecentRow>): HomeRecentRow {
  return {
    id: 't1',
    title: 'Fix the build',
    startedAt: Date.now() - 3 * 60_000,
    projectPath: '/repo',
    projectName: 'repo',
    connectionId: 'mac',
    connectionLabel: 'Studio Mac',
    status: null,
    unread: 0,
    ...patch,
  }
}

function render(page: HomeRecentsPage) {
  const onOpen = jest.fn()
  const onShowMore = jest.fn()
  const view = renderComponent(<RecentsList page={page} onOpen={onOpen} onShowMore={onShowMore} />)
  return { view, onOpen, onShowMore }
}

it('shows the empty copy when there are no chats', () => {
  const { view } = render({ items: [], total: 0 })
  expect(view.texts()).toEqual([
    'Recents',
    'No recent chats yet',
    'Open a machine and choose a project to start or resume a chat.',
  ])
})

it('shows title, project and machine, then the time or the status', () => {
  const { view } = render({
    items: [row({}), row({ id: 't2', title: 'Deploy', status: 'Working' }), row({ id: 't3', status: 'Approval' })],
    total: 3,
  })
  const texts = view.texts()
  expect(texts.slice(0, 4)).toEqual(['Recents', 'Fix the build', 'repo · Studio Mac', '3m'])
  expect(texts).toContain('Working')
  expect(texts).toContain('Approval')
  expect(view.countHostType('ActivityIndicator')).toBe(1)
  expect(texts).not.toContain('Show more')
})

it('opens the chat on tap and offers Show more while rows remain', () => {
  const first = row({})
  const { view, onOpen, onShowMore } = render({ items: [first], total: 6 })
  act(() => view.root.findByProps({ testID: 'recent-mac:t1' }).props.onPress())
  expect(onOpen).toHaveBeenCalledWith(first)
  act(() => view.root.findByProps({ testID: 'recents-show-more' }).props.onPress())
  expect(onShowMore).toHaveBeenCalled()
})
