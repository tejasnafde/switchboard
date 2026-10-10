import { describe, expect, it } from 'vitest'
import {
  canRetryAfterCompact,
  isPromptTooLongResult,
  isPromptTooLongText,
  userMessageText,
} from '../../src/main/provider/claude-prompt-too-long'

describe('claude prompt too long rules', () => {
  it('recognises the CLI text and nothing else', () => {
    expect(isPromptTooLongText('Prompt is too long')).toBe(true)
    expect(isPromptTooLongText('API Error: prompt is too long: 1012345 tokens > 1000000 maximum')).toBe(true)
    expect(isPromptTooLongText('The prompt was long, so it took a while')).toBe(false)
    expect(isPromptTooLongText(undefined)).toBe(false)
  })

  it('recognises a result by its terminal reason or its error text', () => {
    expect(isPromptTooLongResult({ terminal_reason: 'prompt_too_long' })).toBe(true)
    expect(isPromptTooLongResult({ is_error: true, result: 'Prompt is too long' })).toBe(true)
    expect(isPromptTooLongResult({ is_error: true, errors: ['Prompt is too long'] })).toBe(true)
    // A successful reply that merely quotes the phrase is not a failure.
    expect(isPromptTooLongResult({ is_error: false, result: 'The CLI says "Prompt is too long" when...' })).toBe(false)
    expect(isPromptTooLongResult({ is_error: true, result: 'Overloaded' })).toBe(false)
  })

  it('reads text from string and block content', () => {
    expect(userMessageText('hi')).toBe('hi')
    expect(userMessageText([{ type: 'image', source: {} }, { type: 'text', text: 'look' }])).toBe('look')
    expect(userMessageText(undefined)).toBe('')
  })

  it('never compacts a turn that was itself a /compact', () => {
    expect(canRetryAfterCompact(['carry on'])).toBe(true)
    expect(canRetryAfterCompact(['/compact'])).toBe(false)
    expect(canRetryAfterCompact(['  /compact keep the API notes'])).toBe(false)
    expect(canRetryAfterCompact(['/compactor run'])).toBe(true)
    expect(canRetryAfterCompact(['/compact-notes'])).toBe(true)
    expect(canRetryAfterCompact([])).toBe(false)
  })
})
