/** A fork's summary card in its parent: Edit and Discard only while pending and only on a backend that takes them. */
import React from 'react'
import { act } from 'react-test-renderer'
import type { MergeBackRow } from '@shared/merge-back'
import { MergeBackItem } from '../ThreadFeedItems'
import { renderComponent } from '../../test/render'

const row: MergeBackRow = { id: 'mb1', fork: 'f', forkTitle: 'paging', state: 'pending', turns: 2, omittedTurns: 0, files: ['a.ts'], moreFiles: 0, text: 'the summary' }
const item = (over: Partial<MergeBackRow> = {}) => ({ kind: 'mergeBack' as const, id: 'h-mergeback_mb1', messageId: 'mergeback_mb1', row: { ...row, ...over } })

describe('MergeBackItem', () => {
  it('offers Edit and Discard on a pending card', () => {
    const onEdit = jest.fn()
    const onDiscard = jest.fn()
    const v = renderComponent(<MergeBackItem item={item()} canAct busy={false} onEdit={onEdit} onDiscard={onDiscard} />)
    expect(v.texts()).toEqual([
      'From fork "paging" (not sent yet)',
      '2 turns since the fork point or the last send',
      'Changed: a.ts',
      'Edit',
      'Discard',
      'Goes to the agent with your next message.',
    ])
    act(() => { v.root.findByProps({ testID: 'merge-back-edit' }).props.onPress() })
    act(() => { v.root.findByProps({ testID: 'merge-back-discard' }).props.onPress() })
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('shows no action on an older backend, and a refusal on the card', () => {
    const v = renderComponent(<MergeBackItem item={item()} canAct={false} busy={false} error="Already sent." onEdit={() => {}} onDiscard={() => {}} />)
    expect(v.root.findAllByProps({ testID: 'merge-back-edit' })).toEqual([])
    expect(v.texts()).toContain('Already sent.')
  })

  it('shows a delivered row with its summary behind a toggle and no actions', () => {
    const v = renderComponent(<MergeBackItem item={item({ state: 'delivered' })} canAct busy={false} onEdit={() => {}} onDiscard={() => {}} />)
    expect(v.texts()).toEqual(['From fork "paging" · Sent with your message', 'Show summary'])
    act(() => { v.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button').props.onPress() })
    expect(v.texts()).toContain('the summary')
  })
})
