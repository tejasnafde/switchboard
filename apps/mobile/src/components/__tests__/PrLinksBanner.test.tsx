import React from 'react'
import { act } from 'react-test-renderer'
import type { PrLink } from '@shared/pull-request-links'
import { renderComponent } from '../../test/render'
import { PrLinksBanner } from '../PrLinksBanner'

const merged: PrLink = { ref: { host: 'github', owner: 'acme', name: 'app', number: 612 }, source: 'created', linkedAt: 1, state: 'merged', stateAt: 2 }

it('shows each link with its state and how it was linked', () => {
  const root = renderComponent(<PrLinksBanner links={[merged]} onUnlink={() => {}} />)
  expect(root.texts()).toContain('#612 · merged · Opened by the agent · acme/app')
})

it('renders nothing without links', () => {
  const root = renderComponent(<PrLinksBanner links={[]} onUnlink={() => {}} />)
  expect(root.texts()).toEqual([])
})

it('unlinks the row tapped', () => {
  const onUnlink = jest.fn()
  const root = renderComponent(<PrLinksBanner links={[merged]} onUnlink={onUnlink} />)
  act(() => root.byLabel('Unlink pull request acme/app #612').props.onPress())
  expect(onUnlink).toHaveBeenCalledWith(merged)
})

it('names the repository on each Unlink, so two PRs with one number differ', () => {
  const other: PrLink = { ...merged, ref: { ...merged.ref, owner: 'acme', name: 'lib' } }
  const onUnlink = jest.fn()
  const root = renderComponent(<PrLinksBanner links={[merged, other]} onUnlink={onUnlink} />)
  act(() => root.byLabel('Unlink pull request acme/lib #612').props.onPress())
  expect(onUnlink).toHaveBeenCalledWith(other)
})
