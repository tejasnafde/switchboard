import React from 'react'
import { Alert } from 'react-native'
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
      gitContext={{
        branchLabel: 'fix/totals',
        checkoutLabel: 'Worktree',
        checkoutPath: '/repo/wt',
        parentProjectPath: '/repo',
        loading: false,
        error: null,
      }}
      archiving={false}
      archiveError={null}
      archiveEnabled
      onMode={jest.fn()}
      onOpenModel={jest.fn()}
      onOpenProfile={jest.fn()}
      onRefreshGitContext={jest.fn()}
      onArchive={jest.fn()}
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

  it('shows the branch and the worktree with its parent project', () => {
    const v = view()
    expect(v.byLabel('fix/totals: Worktree · /repo/wt\nParent · /repo')).toBeTruthy()
    expect(v.texts()).toContain('Workspace')
  })

  it('shows a spinner while the branch loads and a retry when it fails', () => {
    const onRefreshGitContext = jest.fn()
    const v = view({
      onRefreshGitContext,
      gitContext: {
        branchLabel: 'Branch unavailable',
        checkoutLabel: 'Project checkout',
        checkoutPath: '/repo',
        parentProjectPath: null,
        loading: true,
        error: 'fatal: not a git repository',
      },
    })
    expect(v.countHostType('ActivityIndicator')).toBe(1)
    expect(v.byLabel(/^Branch unavailable:/).props.accessibilityState).toEqual({ disabled: false, busy: true })
    expect(v.texts()).toEqual(expect.arrayContaining(['Could not refresh branch', 'fatal: not a git repository']))
    act(() => v.byLabel('Retry').props.onPress())
    expect(onRefreshGitContext).toHaveBeenCalled()
  })

  it('archives only after the user confirms', () => {
    const onArchive = jest.fn()
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    const v = view({ onArchive })
    act(() => v.byLabel(/^Archive conversation:/).props.onPress())
    expect(onArchive).not.toHaveBeenCalled()
    const [title, , buttons] = alert.mock.calls[0]
    expect(title).toBe('Archive this conversation?')
    act(() => buttons?.find((b) => b.text === 'Archive')?.onPress?.())
    expect(onArchive).toHaveBeenCalled()
    alert.mockRestore()
  })

  it('disables archive during a turn and shows a failed archive', () => {
    const v = view({ archiveEnabled: false, archiveError: 'Backend did not confirm the archive' })
    expect(v.byLabel(/^Archive conversation:/).props.accessibilityState).toEqual({ disabled: true, busy: false })
    expect(v.texts()).toEqual(
      expect.arrayContaining(['Could not archive conversation', 'Backend did not confirm the archive']),
    )
  })
})
