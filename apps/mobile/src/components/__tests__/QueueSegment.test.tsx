import React from 'react'
import { act } from 'react-test-renderer'
import { queueToggle } from '../../lib/held-turns'
import { renderComponent } from '../../test/render'
import { QueueSegment } from '../QueueSegment'

describe('QueueSegment', () => {
  it('is one switch for a screen reader, its state the hint', () => {
    const v = renderComponent(<QueueSegment toggle={queueToggle('steer', false)} flipped={false} onFlip={() => {}} />)
    const segment = v.byLabel('Send after this turn instead of steering it')
    expect(segment.props.testID).toBe('queue-next-toggle')
    expect(segment.props.accessibilityRole).toBe('switch')
    expect(segment.props.accessibilityValue).toEqual({ text: 'Steering the running turn · tap to queue' })
    expect(v.texts()).toEqual(['Steer', 'Queue'])
  })

  it('flips on the other segment only', () => {
    const onFlip = jest.fn()
    const v = renderComponent(<QueueSegment toggle={queueToggle('steer', false)} flipped={false} onFlip={onFlip} />)
    const [steer] = v.root.findAllByProps({ testID: 'queue-segment-steer' })
    const [queue] = v.root.findAllByProps({ testID: 'queue-segment-queue' })
    expect(steer.props.onPress).toBeUndefined()
    act(() => queue.props.onPress())
    expect(onFlip).toHaveBeenCalledTimes(1)
  })

  it('flips from the screen reader activate action', () => {
    const onFlip = jest.fn()
    const v = renderComponent(<QueueSegment toggle={queueToggle('queue', false)} flipped={false} onFlip={onFlip} />)
    act(() => v.byLabel('Steer the running turn instead of queueing').props.onAccessibilityAction())
    expect(onFlip).toHaveBeenCalledTimes(1)
  })
})
