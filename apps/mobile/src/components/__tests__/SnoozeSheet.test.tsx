/** What the Snooze sheet renders; its items come from lib/snooze-sheet.ts (home-recents-snooze.test.ts). */
import React from 'react'
import { act } from 'react-test-renderer'
import { SnoozeSheet } from '../SnoozeSheet'
import { renderComponent } from '../../test/render'
import { snoozeSheetItems } from '../../lib/snooze-sheet'

const monday = new Date(2026, 10, 2, 9, 0)

it('lists each preset with its wake time and the PR item, and picks one on tap', () => {
  const items = snoozeSheetItems(monday, { key: 'github:acme/app#512', number: 512 })
  const onPick = jest.fn()
  const view = renderComponent(
    <SnoozeSheet title="Fix the build" items={items} notice={null} busy={false} onPick={onPick} onClose={jest.fn()} />,
  )
  expect(view.texts()).toEqual([
    'Snooze',
    'Fix the build',
    'Later today',
    '12:00',
    'Tonight',
    '20:00',
    'Tomorrow morning',
    'Tue 09:00',
    'Next week',
    '9 Nov',
    'Until PR #512 changes',
  ])
  act(() => view.root.findByProps({ testID: 'snooze-Tonight' }).props.onPress())
  expect(onPick).toHaveBeenCalledWith(items[1])
})

it('shows a refusal on its last line', () => {
  const view = renderComponent(
    <SnoozeSheet
      title="Fix the build"
      items={snoozeSheetItems(monday, null)}
      notice="A chat that needs you cannot be snoozed"
      busy={false}
      onPick={jest.fn()}
      onClose={jest.fn()}
    />,
  )
  expect(view.texts().at(-1)).toBe('A chat that needs you cannot be snoozed')
})
