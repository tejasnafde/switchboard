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
    snoozable: false,
    woke: false,
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
  const { view } = render({ items: [], total: 0, snoozed: [] })
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
    snoozed: [],
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
  const { view, onOpen, onShowMore } = render({ items: [first], total: 6, snoozed: [] })
  act(() => view.root.findByProps({ testID: 'recent-mac:t1' }).props.onPress())
  expect(onOpen).toHaveBeenCalledWith(first)
  act(() => view.root.findByProps({ testID: 'recents-show-more' }).props.onPress())
  expect(onShowMore).toHaveBeenCalled()
})

describe('Snooze', () => {
  const tonight = new Date()
  tonight.setHours(23, 59, 0, 0)

  function renderSnooze(page: HomeRecentsPage) {
    const onOpen = jest.fn()
    const onSnooze = jest.fn()
    const onWake = jest.fn()
    const view = renderComponent(
      <RecentsList page={page} onOpen={onOpen} onShowMore={jest.fn()} onSnooze={onSnooze} onWake={onWake} />,
    )
    return { view, onOpen, onSnooze, onWake }
  }

  it('keeps the Snoozed shelf collapsed until tapped, then lists wake labels and Wake', () => {
    const snoozed = row({ id: 's1', title: 'Parked', snoozable: true, snoozedAt: 1, snoozedUntil: tonight.getTime() })
    const pr = row({
      id: 's2',
      title: 'On a PR',
      snoozable: true,
      snoozedAt: 1,
      snoozedUntil: null,
      snoozePr: 'github:acme/app#512',
    })
    const { view, onWake, onOpen } = renderSnooze({
      items: [row({ snoozable: true })],
      total: 1,
      snoozed: [snoozed, pr],
    })
    expect(view.texts()).toContain('Snoozed 2')
    expect(view.texts()).not.toContain('Parked')
    act(() => view.root.findByProps({ testID: 'recents-snoozed' }).props.onPress())
    const texts = view.texts()
    expect(texts.slice(texts.indexOf('Snoozed 2') + 1)).toEqual([
      'Parked',
      'repo · Studio Mac',
      '23:59',
      'Wake',
      'On a PR',
      'repo · Studio Mac',
      'PR #512',
      'Wake',
    ])
    act(() => view.root.findByProps({ testID: 'wake-mac:s1' }).props.onPress())
    expect(onWake).toHaveBeenCalledWith(snoozed)
    act(() => view.root.findByProps({ testID: 'snoozed-mac:s2' }).props.onPress())
    expect(onOpen).toHaveBeenCalledWith(pr)
  })

  it('shows no shelf with nothing snoozed, and no empty copy while the shelf has chats', () => {
    expect(renderSnooze({ items: [row({})], total: 1, snoozed: [] }).view.texts()).not.toContain('Snoozed 0')
    const shelfOnly = renderSnooze({
      items: [],
      total: 0,
      snoozed: [row({ snoozable: true, snoozedAt: 1, snoozedUntil: tonight.getTime() })],
    })
    expect(shelfOnly.view.texts()).toEqual(['Recents', 'chevron-forward', 'Snoozed 1'])
  })

  it('marks a woken row with a bold title and Woke in place of the time', () => {
    const { view } = renderSnooze({
      items: [row({ woke: true, snoozable: true }), row({ id: 't2', title: 'Other' })],
      total: 2,
      snoozed: [],
    })
    const texts = view.texts()
    expect(texts.slice(1, 4)).toEqual(['Fix the build', 'repo · Studio Mac', 'Woke'])
    const title = view.root.findAll((n) => typeof n.type === 'string' && n.props.children === 'Fix the build')[0]
    expect(JSON.stringify(title.props.style)).toContain('InstrumentSans_700Bold')
  })

  it('opens the sheet on a long press, but not on a chat that needs the user or a backend without Snooze', () => {
    const plain = row({ snoozable: true })
    const { view, onSnooze } = renderSnooze({
      items: [plain, row({ id: 'a', status: 'Approval', snoozable: true }), row({ id: 'old', snoozable: false })],
      total: 3,
      snoozed: [],
    })
    act(() => view.root.findByProps({ testID: 'recent-mac:t1' }).props.onLongPress())
    expect(onSnooze).toHaveBeenCalledWith(plain)
    expect(view.root.findByProps({ testID: 'recent-mac:a' }).props.onLongPress).toBeUndefined()
    expect(view.root.findByProps({ testID: 'recent-mac:old' }).props.onLongPress).toBeUndefined()
  })

  it('shows a refusal line under Recents', () => {
    const view = renderComponent(
      <RecentsList
        page={{ items: [row({})], total: 1, snoozed: [] }}
        notice="This chat is no longer snoozed"
        onOpen={jest.fn()}
        onShowMore={jest.fn()}
      />,
    )
    expect(view.texts().slice(0, 2)).toEqual(['Recents', 'This chat is no longer snoozed'])
  })
})

describe('Settle', () => {
  it('opens the sheet on a Done or idle row of a backend with Settle, and not on a working one without Snooze', () => {
    const idle = row({ settleable: true })
    const done = row({ id: 'd', status: 'Done', settleable: true })
    const onSnooze = jest.fn()
    const view = renderComponent(
      <RecentsList
        page={{ items: [idle, done, row({ id: 'w', status: 'Working', settleable: true })], total: 3, snoozed: [] }}
        onOpen={jest.fn()}
        onShowMore={jest.fn()}
        onSnooze={onSnooze}
      />,
    )
    const pressable = (id: string) => view.root.findByProps({ testID: `recent-mac:${id}` })
    expect(pressable('t1').props.accessibilityHint).toBe('Long press to settle')
    act(() => pressable('d').props.onLongPress())
    expect(onSnooze).toHaveBeenCalledWith(done)
    expect(pressable('w').props.onLongPress).toBeUndefined()
  })

  it('says both actions on a row that can snooze and settle', () => {
    const view = renderComponent(
      <RecentsList
        page={{ items: [row({ snoozable: true, settleable: true })], total: 1, snoozed: [] }}
        onOpen={jest.fn()}
        onShowMore={jest.fn()}
        onSnooze={jest.fn()}
      />,
    )
    expect(view.root.findByProps({ testID: 'recent-mac:t1' }).props.accessibilityHint).toBe(
      'Long press to snooze or settle',
    )
  })

  it('shows the settle notice with Undo above the rows', () => {
    const onUndo = jest.fn()
    const view = renderComponent(
      <RecentsList
        page={{ items: [row({})], total: 1, snoozed: [] }}
        undo="Settled Fix login: PR #452 merged"
        onUndo={onUndo}
        onOpen={jest.fn()}
        onShowMore={jest.fn()}
      />,
    )
    expect(view.texts().slice(0, 4)).toEqual(['Recents', 'Settled Fix login: PR #452 merged', 'Undo', 'Fix the build'])
    act(() => view.root.findByProps({ testID: 'settle-undo' }).props.onPress())
    expect(onUndo).toHaveBeenCalled()
  })
})
