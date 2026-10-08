/** A message a session link refused: what it says, and Send. */
import React from 'react'
import { act } from 'react-test-renderer'
import { PeerUndeliveredItem } from '../ThreadFeedItems'
import { renderComponent } from '../../test/render'

const item = (over: { sent?: boolean; text?: string } = {}) => ({
  kind: 'undelivered' as const,
  id: 'h-pu_1',
  messageId: 'pu_1',
  row: {
    to: 'agent_2',
    toLabel: 'Roadmap Deepdive',
    reason: 'link-expired' as const,
    text: over.text ?? 'Found the bug',
    sent: over.sent ?? false,
  },
})

describe('PeerUndeliveredItem', () => {
  it('names the target, the reason and the message, and sends on tap', () => {
    const onSend = jest.fn()
    const v = renderComponent(<PeerUndeliveredItem item={item()} sending={false} onSend={onSend} />)
    expect(v.texts()).toEqual([
      'Not delivered to Roadmap Deepdive',
      "The link's time ran out.",
      'Found the bug',
      'Send',
    ])
    act(() => {
      v.root.findByProps({ testID: 'peer-undelivered-send' }).props.onPress()
    })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('drops Send once the user sent it', () => {
    const v = renderComponent(<PeerUndeliveredItem item={item({ sent: true })} sending={false} onSend={() => {}} />)
    expect(v.texts()).toEqual(['Sent by you to Roadmap Deepdive after the link ran out', 'Found the bug'])
  })

  it('clamps a long message until Show more, and shows a refusal', () => {
    const text = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n')
    const v = renderComponent(
      <PeerUndeliveredItem
        item={item({ text })}
        sending={false}
        error="That session is not running."
        onSend={() => {}}
      />,
    )
    const body = () => v.root.find((n) => typeof n.type === 'string' && n.props.children === text)
    expect(body().props.numberOfLines).toBe(4)
    expect(v.texts()).toContain('That session is not running.')
    act(() => {
      v.root
        .find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && !n.props.testID)
        .props.onPress()
    })
    expect(body().props.numberOfLines).toBeUndefined()
  })
})
