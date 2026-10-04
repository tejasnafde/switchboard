import React from 'react'
import { HistoryPageStatus } from '../../components/HistoryPageStatus'
import { renderComponent } from '../../test/render'

it('shows a small older-page indicator only while paging', () => {
  const hidden = renderComponent(<HistoryPageStatus loading={false} />)
  expect(hidden.texts()).toEqual([])
  const visible = renderComponent(<HistoryPageStatus loading />)
  expect(visible.texts()).toContain('Loading older messages')
  expect(visible.texts().join(' ')).not.toContain('Showing saved messages')
})
