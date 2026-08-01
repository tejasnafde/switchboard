/**
 * The composer's primary button, rendered.
 *
 * `lib/composer.ts` already unit-tests the rules; nothing checked that the
 * component renders the state those rules produce. That gap is where a wrong
 * glyph or a missing label would live.
 */
import React from 'react'
import { SendMicButton } from '../SendMicButton'
import type { Dictation } from '../../hooks/useDictation'
import { renderComponent, type Node } from '../../test/render'

function dictation(over: Partial<Dictation> = {}): Dictation {
  return {
    available: true,
    listening: false,
    start: jest.fn(async () => true),
    stop: jest.fn(),
    ...over,
  }
}

function view(props: Partial<React.ComponentProps<typeof SendMicButton>> = {}) {
  return renderComponent(
    <SendMicButton
      canSend={false}
      isRunning={false}
      dictation={props.dictation ?? dictation()}
      onSend={jest.fn()}
      onStopTurn={jest.fn()}
      {...props}
    />,
  )
}

describe('SendMicButton', () => {
  it('is a send arrow when there is something to send', () => {
    const v = view({ canSend: true })
    expect(v.byLabel('Send message')).toBeTruthy()
    expect(v.iconNames()).toContain('arrow-up')
  })

  it('is a mic on an empty idle composer', () => {
    const v = view()
    expect(v.byLabel(/hold to dictate/i)).toBeTruthy()
    expect(v.iconNames()).toContain('mic')
  })

  it('is a stop square when running with nothing to send', () => {
    const v = view({ isRunning: true })
    expect(v.byLabel('Stop the agent')).toBeTruthy()
    expect(v.iconNames()).toContain('stop')
  })

  it('still offers send during a turn, because a follow-up is queued', () => {
    // Regression: Stop used to REPLACE Send, making a mid-turn follow-up
    // impossible to type at all.
    const v = view({ isRunning: true, canSend: true })
    expect(v.byLabel('Send message')).toBeTruthy()
    expect(v.iconNames()).toContain('arrow-up')
    expect(v.iconNames()).not.toContain('mic')
  })

  it('shows the hold hint while dictating, so the gesture is discoverable', () => {
    const v = view({ dictation: dictation({ listening: true }) })
    expect(v.texts().join(' ')).toMatch(/slide up to lock/i)
  })

  it('shows no hint when idle', () => {
    expect(view().texts().join(' ')).not.toMatch(/slide up/i)
  })

  it('renders exactly one primary button in every state', () => {
    // Two tappable circles in the composer would be ambiguous.
    for (const props of [
      {},
      { canSend: true },
      { isRunning: true },
      { isRunning: true, canSend: true },
    ]) {
      const v = view(props)
      const buttons = v.root.findAll((n: Node) => n.props?.accessibilityRole === 'button', { deep: false })
      expect(buttons).toHaveLength(1)
    }
  })
})
