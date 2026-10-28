import React from 'react'
import { act } from 'react-test-renderer'
import { renderComponent } from '../../test/render'
import { AttachRefusals, AttachSheet, FileChips } from '../FileAttachments'

describe('FileChips', () => {
  const files = [
    { id: 'file-a', name: 'spec.pdf', label: 'spec.pdf (12 pages)', path: '/x/spec.pdf' },
    { id: 'file-b', name: 'pasted-text-1.txt', label: 'pasted-text-1.txt' },
  ]

  it('shows each chip by its label, with a remove control named after the file', () => {
    const v = renderComponent(<FileChips files={files} onRemove={() => {}} />)
    expect(v.texts()).toEqual(expect.arrayContaining(['spec.pdf (12 pages)', 'pasted-text-1.txt']))
    expect(v.byLabel('Remove spec.pdf')).toBeTruthy()
    expect(v.byLabel('Remove pasted-text-1.txt')).toBeTruthy()
  })

  it('shows a spinner on a chip whose upload is running', () => {
    const v = renderComponent(<FileChips files={files} onRemove={() => {}} />)
    expect(v.countHostType('ActivityIndicator')).toBe(1)
    expect(v.allByLabel('Uploading pasted-text-1.txt').length).toBeGreaterThan(0)
  })

  it('removes the chip whose cross was pressed', () => {
    const onRemove = jest.fn()
    const v = renderComponent(<FileChips files={files} onRemove={onRemove} />)
    act(() => v.byLabel('Remove spec.pdf').props.onPress())
    expect(onRemove).toHaveBeenCalledWith('file-a')
  })

  it('renders nothing with no files', () => {
    const v = renderComponent(<FileChips files={[]} onRemove={() => {}} />)
    expect(v.texts()).toEqual([])
  })
})

describe('AttachRefusals', () => {
  it('shows one line per refused file', () => {
    const lines = [
      'big.zip was not attached: 12 MB is over the 10 MB file limit.',
      'scan.tiff was not attached: TIFF images are not supported. Use PNG, JPEG, WebP, GIF or HEIC.',
    ]
    const v = renderComponent(<AttachRefusals lines={lines} onDismiss={() => {}} />)
    expect(v.texts().filter((t) => t.includes('was not attached'))).toEqual(lines)
  })
})

describe('AttachSheet', () => {
  it('offers Photos and Files', () => {
    const onPick = jest.fn()
    const v = renderComponent(<AttachSheet visible onPick={onPick} onClose={() => {}} onDismiss={() => {}} />)
    act(() => v.byLabel('Files').props.onPress())
    act(() => v.byLabel('Photos').props.onPress())
    expect(onPick.mock.calls).toEqual([['files'], ['photos']])
  })
})
