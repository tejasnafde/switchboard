/** Rows for retries, drift, spend blocks, peer messages and the agent's checklist. */
import React from 'react'
import { EventRowItem } from '../EventRowItem'
import { renderComponent } from '../../test/render'

describe('EventRowItem', () => {
  it('spins while a retry runs and stops once it has finished', () => {
    const retry = { kind: 'retry' as const, id: 'r-1', turnId: '1', message: 'Overloaded' }
    const running = renderComponent(<EventRowItem item={{ ...retry, active: true }} />)
    expect(running.texts()).toEqual(['Retrying', 'Overloaded'])
    expect(running.countHostType('ActivityIndicator')).toBe(1)
    const done = renderComponent(<EventRowItem item={{ ...retry, active: false }} />)
    expect(done.texts()).toEqual(['Retry finished', 'Overloaded'])
    expect(done.countHostType('ActivityIndicator')).toBe(0)
  })

  it('shows a received peer message with the other chat', () => {
    const v = renderComponent(
      <EventRowItem
        item={{
          kind: 'peer',
          id: 'h-1',
          direction: 'received',
          initiator: 'agent',
          peerThreadId: 'agent_2',
          peerLabel: 'Roadmap',
          text: 'Found it',
          at: 1,
        }}
      />,
    )
    expect(v.texts()).toEqual(['Received · Roadmap', 'Found it', 'agent · agent_2'])
  })

  it('marks each todo by its status', () => {
    const v = renderComponent(
      <EventRowItem
        item={{
          kind: 'todo',
          id: 'todo-1',
          todoId: '1',
          items: [
            { text: 'Read', status: 'completed' },
            { text: 'Fix', status: 'in_progress' },
            { text: 'Test', status: 'pending' },
          ],
        }}
      />,
    )
    expect(v.iconNames()).toEqual(['checkmark-circle', 'radio-button-on', 'ellipse-outline'])
    expect(v.texts().filter((t) => !v.iconNames().includes(t))).toEqual(['Todo', 'Read', 'Fix', 'Test'])
  })
})
