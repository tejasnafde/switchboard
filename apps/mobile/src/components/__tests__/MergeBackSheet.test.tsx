/** Send a fork back to its parent, or edit the parent's card: the summary, editable, then the call. */
import React from 'react'
import { act } from 'react-test-renderer'
import type { MergeBackPreview } from '@shared/merge-back'
import { renderComponent } from '../../test/render'
import { MergeBackSheet, type MergeBackSheetApi } from '../MergeBackSheet'

const token = { from: { at: 0, ids: [] }, through: { at: 5, ids: ['m5'] } }
const ready: MergeBackPreview = {
  status: 'ready', parentId: 'p', parentTitle: 'improvements', text: 'From the fork', turns: 2, omittedTurns: 0,
  files: ['a.ts'], moreFiles: 0, replacesPending: true, token,
}

function api(over: Partial<MergeBackSheetApi> = {}): MergeBackSheetApi {
  return {
    preview: jest.fn(async () => ready),
    send: jest.fn(async () => ({ ok: true as const })),
    edit: jest.fn(async () => ({ ok: true as const })),
    ...over,
  }
}

const flush = () => act(async () => { await Promise.resolve() })
const sendMode = { kind: 'send' as const, forkThreadId: 'fork-1', parentTitle: 'improvements' }

describe('MergeBackSheet', () => {
  it('shows the summary, sends the edited text with the preview token, then closes', async () => {
    const a = api()
    const onClose = jest.fn()
    const v = renderComponent(<MergeBackSheet mode={sendMode} api={a} onClose={onClose} />)
    expect(v.texts()).toContain('Building the summary…')
    await flush()
    expect(a.preview).toHaveBeenCalledWith('fork-1')
    expect(v.texts()).toEqual(expect.arrayContaining([
      'Send back to "improvements"',
      '2 turns · 1 file changed',
      'A summary from this fork is already waiting in the parent. Sending replaces it.',
      'Send back',
    ]))
    const input = v.root.findByProps({ testID: 'merge-back-text' })
    expect(input.props.value).toBe('From the fork')
    act(() => input.props.onChangeText('From the fork, trimmed'))
    await act(async () => { v.root.findByProps({ testID: 'merge-back-submit' }).props.onPress() })
    expect(a.send).toHaveBeenCalledWith('fork-1', 'From the fork, trimmed', token)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the sheet open with the reason when the backend refuses', async () => {
    const a = api({ send: jest.fn(async () => ({ ok: false as const, message: 'The parent chat is archived.' })) })
    const onClose = jest.fn()
    const v = renderComponent(<MergeBackSheet mode={sendMode} api={a} onClose={onClose} />)
    await flush()
    await act(async () => { v.root.findByProps({ testID: 'merge-back-submit' }).props.onPress() })
    expect(v.texts()).toContain('The parent chat is archived.')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says why nothing can be sent, with no Send button', async () => {
    const a = api({ preview: jest.fn(async (): Promise<MergeBackPreview> => ({ status: 'empty', parentTitle: 'improvements', message: 'Nothing new since the last send.' })) })
    const v = renderComponent(<MergeBackSheet mode={sendMode} api={a} onClose={() => {}} />)
    await flush()
    expect(v.texts()).toContain('Nothing new since the last send.')
    expect(v.root.findAllByProps({ testID: 'merge-back-submit' })).toEqual([])
  })

  it('edits the parent card in place and refuses an empty summary', async () => {
    const a = api()
    const onClose = jest.fn()
    const v = renderComponent(
      <MergeBackSheet mode={{ kind: 'edit', parentThreadId: 'parent-1', mergeBackId: 'mb1', forkTitle: 'paging', text: 'old' }} api={a} onClose={onClose} />,
    )
    expect(a.preview).not.toHaveBeenCalled()
    expect(v.texts()).toEqual(expect.arrayContaining(['Edit the summary from fork "paging"', 'Save']))
    const input = () => v.root.findByProps({ testID: 'merge-back-text' })
    act(() => input().props.onChangeText('  '))
    expect(v.root.findByProps({ testID: 'merge-back-submit' }).props.disabled).toBe(true)
    act(() => input().props.onChangeText('new'))
    await act(async () => { v.root.findByProps({ testID: 'merge-back-submit' }).props.onPress() })
    expect(a.edit).toHaveBeenCalledWith('parent-1', 'mb1', 'new')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
