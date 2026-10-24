/**
 * The new-session worktree card: which recovery buttons render and what they send.
 * The rules for when each shows live in lib/new-session-creation.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { WorktreeCreationCard } from '../WorktreeCreationCard'
import type { MobileNewSessionCreationActions } from '../../lib/new-session-creation'
import { renderComponent } from '../../test/render'

const none: MobileNewSessionCreationActions = {
  canRetry: false,
  canStartInProject: false,
  canChooseSetupRun: false,
  canChooseSetupSkip: false,
  canCheckStatus: false,
  canCancel: false,
  canRetain: false,
  canRemove: false,
  progressLabel: 'Worktree cleanup required',
}

function render(actions: Partial<MobileNewSessionCreationActions>, onAct = jest.fn(), onCheckStatus = jest.fn()) {
  return renderComponent(
    <WorktreeCreationCard
      actions={{ ...none, ...actions }}
      error="Startup did not confirm."
      spinning={false}
      onAct={onAct}
      onRetry={() => {}}
      onCheckStatus={onCheckStatus}
      onStartInProject={() => {}}
    />,
  )
}

describe('WorktreeCreationCard', () => {
  it('shows the title, correlation, error and only the offered actions', () => {
    const v = render({
      canRetain: true,
      canRemove: true,
      canCheckStatus: true,
      correlation: 'Creation create-1, revision 3',
    })
    expect(v.texts()).toEqual([
      'Worktree cleanup required',
      'Creation create-1, revision 3',
      'Startup did not confirm.',
      'Check status',
      'Keep worktree',
      'Remove worktree',
    ])
  })

  it('sends the tapped recovery action', () => {
    const onAct = jest.fn()
    const onCheckStatus = jest.fn()
    const v = render({ canCancel: true, canRemove: true, canCheckStatus: true }, onAct, onCheckStatus)
    act(() => {
      v.root.findByProps({ accessibilityLabel: 'Cancel worktree creation' }).props.onPress()
      v.root.findByProps({ accessibilityLabel: 'Remove worktree' }).props.onPress()
      v.root.findByProps({ accessibilityLabel: 'Check status' }).props.onPress()
    })
    expect(onAct.mock.calls).toEqual([['cancel'], ['remove']])
    expect(onCheckStatus).toHaveBeenCalledTimes(1)
  })
})
