import React from 'react'
import { act } from 'react-test-renderer'
import type { PrLink } from '@shared/pull-request-links'
import { renderComponent } from '../../test/render'
import { PrLinksChip, PrLinksSheet } from '../PrLinks'

const merged: PrLink = {
  ref: { host: 'github', owner: 'acme', name: 'app', number: 612 },
  source: 'created',
  linkedAt: 1,
  state: 'merged',
  stateAt: 2,
}
const other: PrLink = { ...merged, ref: { ...merged.ref, owner: 'acme', name: 'lib' } }

describe('PrLinksChip', () => {
  it('names the first link and counts the rest', () => {
    const root = renderComponent(<PrLinksChip links={[merged, other]} onPress={() => {}} />)
    expect(root.texts()).toContain('#612 +1')
    expect(root.byLabel('Linked pull requests, 2')).toBeTruthy()
  })

  it('renders nothing without links', () => {
    const root = renderComponent(<PrLinksChip links={[]} onPress={() => {}} />)
    expect(root.texts()).toEqual([])
  })

  it('opens the sheet on a tap', () => {
    const onPress = jest.fn()
    const root = renderComponent(<PrLinksChip links={[merged]} onPress={onPress} />)
    act(() => root.byLabel('Linked pull requests, 1').props.onPress())
    expect(onPress).toHaveBeenCalled()
  })
})

describe('PrLinksSheet', () => {
  it('shows each link on two lines and keeps the one-line text for the screen reader', () => {
    const root = renderComponent(<PrLinksSheet visible links={[merged]} onUnlink={() => {}} onClose={() => {}} />)
    const text = root.texts().join('|')
    expect(text).toContain('Linked pull requests')
    expect(text).toContain('#612')
    expect(text).toContain(' acme/app')
    expect(text).toContain('Merged · Opened by the agent')
    expect(root.byLabel('#612 · merged · Opened by the agent · acme/app')).toBeTruthy()
  })

  it('names the repository on each Unlink, so two PRs with one number differ', () => {
    const onUnlink = jest.fn()
    const root = renderComponent(
      <PrLinksSheet visible links={[merged, other]} onUnlink={onUnlink} onClose={() => {}} />,
    )
    act(() => root.byLabel('Unlink pull request acme/lib #612').props.onPress())
    expect(onUnlink).toHaveBeenCalledWith(other)
  })
})
