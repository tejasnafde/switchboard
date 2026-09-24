import { describe, expect, it } from 'vitest'
import { parseErrorKind } from '../../src/main/db/parse-error'

describe('parseErrorKind', () => {
  it('keeps the stored text out of what gets logged', () => {
    let caught: unknown
    try { JSON.parse('my password is hunter2') } catch (err) { caught = err }
    // The raw message is what leaked: V8 quotes the input.
    expect((caught as Error).message).toContain('my passwor')
    expect(parseErrorKind(caught)).toBe('SyntaxError')
  })

  it('names a non-Error throw by its type', () => {
    expect(parseErrorKind('boom')).toBe('string')
  })
})
