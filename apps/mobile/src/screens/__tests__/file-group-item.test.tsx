/**
 * A turn's folded "Changed N files" row: what it says and that a tap asks to
 * open that turn. The folding rule itself is in lib/file-groups (vitest).
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { FileGroupItem } from '../ThreadFeedItems'
import { renderComponent } from '../../test/render'

const row = { kind: 'fileGroup' as const, id: 'files:f-a', label: 'Changed 2 files', added: 3, removed: 1, expanded: false }

describe('FileGroupItem', () => {
  it('shows the count and the line totals, collapsed', () => {
    const v = renderComponent(<FileGroupItem row={row} onToggle={() => {}} />)
    // `+{n}` renders as two text children, so join without a separator.
    const text = v.texts().join('')
    expect(text).toContain('Changed 2 files')
    expect(text).toContain('+3')
    expect(text).toContain('-1')
    expect(text).toContain('Show')
    expect(v.root.findByProps({ testID: 'file-group' }).props.accessibilityState).toEqual({ expanded: false })
  })

  it('asks to toggle its own turn when tapped', () => {
    const onToggle = jest.fn()
    const v = renderComponent(<FileGroupItem row={{ ...row, expanded: true }} onToggle={onToggle} />)
    expect(v.texts().join(' ')).toContain('Hide')
    act(() => { v.root.findByProps({ testID: 'file-group' }).props.onPress() })
    expect(onToggle).toHaveBeenCalledWith('files:f-a')
  })
})
