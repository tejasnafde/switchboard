/**
 * The foot of a user bubble the backend holds: the chip, and the two actions
 * with the names a screen reader announces. The rules live in lib/heldTurns.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { HeldTurnBar } from '../ThreadFeedItems'
import { heldTurnActions } from '../../lib/heldTurns'
import { renderComponent } from '../../test/render'

describe('HeldTurnBar', () => {
  it('shows the Queued chip with Send now and Cancel', () => {
    const v = renderComponent(<HeldTurnBar actions={heldTurnActions('claude')} onPromote={() => {}} onCancel={() => {}} />)
    expect(v.texts().join(' ')).toContain('Queued')
    expect(v.texts().join(' ')).toContain('Runs after this turn')
    expect(v.iconNames()).toEqual(expect.arrayContaining(['time-outline', 'arrow-up', 'close']))
    expect(v.root.findByProps({ testID: 'held-send-now' }).props.accessibilityLabel).toBe('Send now')
    expect(v.root.findByProps({ testID: 'held-cancel' }).props.accessibilityLabel).toBe('Cancel')
  })

  it('disables Send now on OpenCode and says why', () => {
    const onPromote = jest.fn()
    const v = renderComponent(<HeldTurnBar actions={heldTurnActions('opencode')} onPromote={onPromote} onCancel={() => {}} />)
    expect(v.root.findByProps({ testID: 'held-send-now' }).props.disabled).toBe(true)
    expect(v.texts().join(' ')).toMatch(/OpenCode cannot take a message mid-turn/)
  })

  it('calls Cancel when tapped', () => {
    const onCancel = jest.fn()
    const v = renderComponent(<HeldTurnBar actions={heldTurnActions('codex')} onPromote={() => {}} onCancel={onCancel} />)
    act(() => { v.root.findByProps({ testID: 'held-cancel' }).props.onPress() })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
