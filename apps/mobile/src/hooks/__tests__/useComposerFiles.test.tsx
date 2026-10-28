import React from 'react'
import { act } from 'react-test-renderer'
import { renderComponent } from '../../test/render'
import { useComposerFiles } from '../useComposerFiles'

const pending: Array<(err: Error) => void> = []
jest.mock('../../stores/connections', () => ({
  getClient: () => ({
    canUploadAttachments: () => true,
    uploadAttachment: () => new Promise((_resolve, reject) => pending.push(reject)),
  }),
}))

describe('useComposerFiles', () => {
  it('a paste whose upload fails goes back into the text, with a refusal line', async () => {
    const pasteFailed = jest.fn()
    let hook!: ReturnType<typeof useComposerFiles>
    function Harness() {
      hook = useComposerFiles('c1', pasteFailed)
      return null
    }
    renderComponent(<Harness />)
    const paste = 'y'.repeat(40 * 1024)
    await act(async () => {
      hook.foldPaste('ab', `a${paste}b`)
    })
    await act(async () => pending.shift()?.(new Error('socket closed')))
    expect(pasteFailed).toHaveBeenCalledWith(1, paste)
    expect(hook.refusals).toEqual(['pasted-text-1.txt was not attached: socket closed'])
    expect(hook.files).toEqual([])
  })

  it('a paste chip removed during its upload stays gone when the upload fails', async () => {
    const pasteFailed = jest.fn()
    let hook!: ReturnType<typeof useComposerFiles>
    function Harness() {
      hook = useComposerFiles('c1', pasteFailed)
      return null
    }
    renderComponent(<Harness />)
    let kept = ''
    await act(async () => {
      kept = hook.foldPaste('', 'x'.repeat(40 * 1024))
    })
    expect(kept).toBe('')
    expect(hook.files).toHaveLength(1)
    await act(async () => hook.remove(hook.files[0].id))
    await act(async () => pending.shift()?.(new Error('socket closed')))
    expect(pasteFailed).not.toHaveBeenCalled()
    expect(hook.refusals).toEqual([])
    expect(hook.files).toEqual([])
  })
})
