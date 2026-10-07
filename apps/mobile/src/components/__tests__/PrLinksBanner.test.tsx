import React from 'react'
import { act } from 'react-test-renderer'
import type { PrLink } from '@shared/pull-request-links'
import { renderComponent } from '../../test/render'
import { PrLinksBanner } from '../PrLinksBanner'

const merged: PrLink = { ref: { host: 'github', owner: 'acme', name: 'app', number: 612 }, source: 'created', linkedAt: 1, state: 'merged', stateAt: 2 }

it('shows each link with its state and how it was linked', () => {
  const root = renderComponent(<PrLinksBanner links={[merged]} onUnlink={() => {}} />)
  expect(root.texts()).toContain('#612 acme/app · merged · Opened by the agent')
})

it('renders nothing without links', () => {
  const root = renderComponent(<PrLinksBanner links={[]} onUnlink={() => {}} />)
  expect(root.texts()).toEqual([])
})

it('unlinks the row tapped', () => {
  const onUnlink = jest.fn()
  const root = renderComponent(<PrLinksBanner links={[merged]} onUnlink={onUnlink} />)
  act(() => root.byLabel('Unlink pull request 612').props.onPress())
  expect(onUnlink).toHaveBeenCalledWith(merged)
})
