/** A background-task notification renders as a label, never as raw XML. */
import React from 'react'
import { act } from 'react-test-renderer'
import { SyntheticRow } from '../SyntheticRow'
import { renderComponent } from '../../test/render'

const part = {
  kind: 'task-notification' as const,
  status: 'failed',
  summary: 'Background command "Build" failed with exit code 144',
  taskId: 'b1',
  outputFile: '/tmp/tasks/b1.output',
}

describe('SyntheticRow', () => {
  it('shows the one-line label and reveals ids on tap', () => {
    const v = renderComponent(<SyntheticRow part={part} />)
    expect(v.texts()).toEqual(['Background task failed: Build (exit 144)'])
    act(() => v.byLabel('Background task failed: Build (exit 144)').props.onPress())
    expect(v.texts().join('\n')).toContain('Output: /tmp/tasks/b1.output')
  })
})
