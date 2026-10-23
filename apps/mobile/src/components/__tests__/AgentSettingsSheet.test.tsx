import React from 'react'
import { act } from 'react-test-renderer'
import { renderComponent } from '../../test/render'
import { AgentSettingsSheet } from '../AgentSettingsSheet'

function view(over: Partial<React.ComponentProps<typeof AgentSettingsSheet>> = {}) {
  return renderComponent(
    <AgentSettingsSheet
      visible
      modelLabel="claude-opus-5-5"
      profileLabel="SSG"
      profileBusy={false}
      mode="full-access"
      usage="576,511 of 1,000,000 tokens · $904.67 · last turn 1.3s"
      onMode={jest.fn()}
      onOpenModel={jest.fn()}
      onOpenProfile={jest.fn()}
      onClose={jest.fn()}
      onDismiss={jest.fn()}
      {...over}
    />,
  )
}

describe('AgentSettingsSheet', () => {
  it('lists the model, the profile, the usage and the mode', () => {
    const v = view()
    expect(v.byLabel('Model: claude-opus-5-5')).toBeTruthy()
    expect(v.byLabel('Agent and profile: SSG')).toBeTruthy()
    expect(v.byLabel('Usage: 576,511 of 1,000,000 tokens · $904.67 · last turn 1.3s')).toBeTruthy()
    expect(v.byLabel('Runtime mode: Full access').props.accessibilityState).toEqual({ selected: true })
  })

  it('hides the model and profile rows when there is nothing to pick', () => {
    const v = view({ modelLabel: null, profileLabel: null, usage: null })
    expect(v.allByLabel(/^Model:/)).toEqual([])
    expect(v.allByLabel(/^Agent and profile:/)).toEqual([])
    expect(v.byLabel('Usage: Nothing reported yet')).toBeTruthy()
  })

  it('picks a mode', () => {
    const onMode = jest.fn()
    const v = view({ onMode })
    act(() => v.byLabel('Runtime mode: Plan').props.onPress())
    expect(onMode).toHaveBeenCalledWith('plan')
  })
})
