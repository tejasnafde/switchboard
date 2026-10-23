/**
 * A changed-file row: its counts and where it changed, and the read-only diff
 * a tap opens. The diff rules themselves are in @shared/compact-file-diff (vitest).
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { FileEditItem } from '../FileEditItem'
import { renderComponent } from '../../test/render'

const item = {
  kind: 'fileEdit' as const,
  id: 'f-1',
  relPath: 'src/upload/putFile.ts',
  changeKind: 'modify' as const,
  oldContent: 'alpha\nbeta\ngamma\n',
  newContent: 'alpha\nBETA\ngamma\n',
}

describe('FileEditItem', () => {
  it('shows the path, the counts and Review while closed', () => {
    const v = renderComponent(<FileEditItem item={item} backendLabel="Mac" expanded={false} onToggle={() => {}} />)
    const text = v.texts().join('')
    expect(text).toContain('src/upload/putFile.ts')
    expect(text).toContain('+1')
    expect(text).toContain('-1')
    expect(text).toContain('Changed on Mac · modify')
    expect(text).toContain('Review')
    expect(v.root.findAllByProps({ testID: 'file-diff:f-1' })).toHaveLength(0)
  })

  it('shows the diff lines and the footer while open, and asks to toggle its own row', () => {
    const onToggle = jest.fn()
    const v = renderComponent(<FileEditItem item={item} backendLabel="Mac" expanded onToggle={onToggle} />)
    const text = v.texts().join(' ')
    expect(text).toContain('Hide')
    expect(text).toContain('BETA')
    expect(text).toContain('Read-only preview')
    act(() => {
      v.root.findByProps({ testID: 'file-edit:f-1' }).props.onPress()
    })
    expect(onToggle).toHaveBeenCalledWith('f-1')
  })

  it('offers no Review for a file whose contents did not change', () => {
    const same = { ...item, newContent: item.oldContent }
    const v = renderComponent(<FileEditItem item={same} backendLabel="Mac" expanded onToggle={() => {}} />)
    expect(v.texts().join(' ')).not.toContain('Review')
    expect(v.root.findByProps({ testID: 'file-edit:f-1' }).props.disabled).toBe(true)
    expect(v.root.findAllByProps({ testID: 'file-diff:f-1' })).toHaveLength(0)
  })

  it('marks approximate counts with ~ and says when a large diff is truncated', () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
    const rewrite = { ...item, oldContent: big, newContent: big.replace(/line/g, 'row') }
    const v = renderComponent(<FileEditItem item={rewrite} backendLabel="Mac" expanded onToggle={() => {}} />)
    const text = v.texts().join('')
    expect(text).toContain('~+400')
    expect(text).toContain('~-400')
    expect(text).toContain('Read-only preview · large diff truncated')
  })
})
