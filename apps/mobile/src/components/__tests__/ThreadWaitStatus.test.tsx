import React from 'react'
import { renderComponent } from '../../test/render'
import { ThreadWaitStatus } from '../ThreadWaitStatus'

it('names the account and explains why send is held', () => {
  const root = renderComponent(<ThreadWaitStatus label="Switching to Work... Send is held; you can keep typing." />)
  expect(root.texts()).toContain('Switching to Work... Send is held; you can keep typing.')
  expect(root.countHostType('ActivityIndicator')).toBe(1)
})

it('renders a failure in place without a spinner', () => {
  const root = renderComponent(<ThreadWaitStatus label="Profile unavailable" error />)
  expect(root.texts()).toContain('Profile unavailable')
  expect(root.countHostType('ActivityIndicator')).toBe(0)
})
