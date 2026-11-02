import React from 'react'
import { act } from 'react-test-renderer'
import { SnoozeLine } from '../SnoozeLine'
import { renderComponent } from '../../test/render'

it('says until when the chat is snoozed and wakes it on Wake now', async () => {
  const at = new Date()
  at.setHours(23, 59, 0, 0)
  const onWake = jest.fn().mockResolvedValue(null)
  const view = renderComponent(
    <SnoozeLine session={{ snoozedAt: 1, snoozedUntil: at.getTime(), snoozePr: null }} onWake={onWake} />,
  )
  expect(view.texts()).toEqual(['Snoozed until 23:59', 'Wake now'])
  await act(async () => view.byLabel('Wake now').props.onPress())
  expect(onWake).toHaveBeenCalled()
})

it('names the PR of a PR-only snooze, shows a refusal, and is absent when not snoozed', async () => {
  const view = renderComponent(
    <SnoozeLine
      session={{ snoozedAt: 1, snoozedUntil: null, snoozePr: 'github:acme/app#512' }}
      onWake={() => Promise.resolve('This chat is no longer snoozed')}
    />,
  )
  expect(view.texts()[0]).toBe('Snoozed until PR #512 changes')
  await act(async () => view.byLabel('Wake now').props.onPress())
  expect(view.texts()).toContain('This chat is no longer snoozed')
  const idle = renderComponent(<SnoozeLine session={{ snoozedAt: null }} onWake={jest.fn()} />)
  expect(idle.texts()).toEqual([])
})
