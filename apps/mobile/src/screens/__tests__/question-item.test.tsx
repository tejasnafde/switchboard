/** An AskUserQuestion option: one 48 pt target, label above its description, a checkbox or radio role. */
import React from 'react'
import { act } from 'react-test-renderer'
import { StyleSheet } from 'react-native'
import { QuestionItem } from '../ThreadFeedItems'
import { renderComponent } from '../../test/render'

const item = (multiSelect: boolean) => ({
  kind: 'question' as const, id: 'q-1', requestId: 'req-1',
  questions: [{
    id: 'how', header: 'Images', question: 'How?', multiSelect,
    options: [{ label: 'Resize on the server', description: 'A long description. '.repeat(10) }, { label: 'Keep' }],
  }],
})

describe('QuestionItem options', () => {
  it('are 48 pt checkbox targets that toggle on tap', () => {
    const v = renderComponent(<QuestionItem item={item(true)} onSubmit={() => {}} />)
    const option = v.root.findByProps({ testID: 'question-option-0-0' })
    expect(StyleSheet.flatten(option.props.style).minHeight).toBe(48)
    expect(option.props.accessibilityRole).toBe('checkbox')
    expect(option.props.accessibilityState).toEqual({ checked: false, disabled: false })
    act(() => option.props.onPress())
    expect(v.root.findByProps({ testID: 'question-option-0-0' }).props.accessibilityState.checked).toBe(true)
  })

  it('are radios for a single choice', () => {
    const v = renderComponent(<QuestionItem item={item(false)} onSubmit={() => {}} />)
    expect(v.root.findByProps({ testID: 'question-option-0-1' }).props.accessibilityRole).toBe('radio')
  })
})
