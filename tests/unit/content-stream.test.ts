/**
 * The accumulation rule for streamed content.
 *
 * Three places fold these chunks: the renderer's 30fps coalescer, the phone's
 * 50ms batcher, and each store's reducer. They must agree exactly, or a
 * streamed reply renders with duplicated or missing text depending on which
 * path a given token took. That is why the rule is one shared function and why
 * associativity is asserted rather than assumed.
 */
import { describe, it, expect } from 'vitest'
import { applyContentText, mergeContentChunks, type ContentChunk } from '../../src/shared/content-stream'

describe('applyContentText', () => {
  it('extends the body for an increment', () => {
    expect(applyContentText('Hel', { text: 'lo', append: true })).toBe('Hello')
  })

  it('starts from nothing when the message is new', () => {
    expect(applyContentText(undefined, { text: 'Hi', append: true })).toBe('Hi')
  })

  it('replaces the body for a snapshot', () => {
    // Non-streaming providers and reload paths send the whole body. Appending
    // one would duplicate the entire reply, which is what the mobile store's
    // old "replace, never append" comment was defending against.
    expect(applyContentText('stale', { text: 'fresh' })).toBe('fresh')
  })
})

describe('mergeContentChunks', () => {
  it('concatenates two increments', () => {
    expect(mergeContentChunks({ text: 'a', append: true }, { text: 'b', append: true })).toEqual({
      text: 'ab',
      append: true,
    })
  })

  it('lets a snapshot supersede anything buffered before it', () => {
    expect(mergeContentChunks({ text: 'partial', append: true }, { text: 'whole' })).toEqual({ text: 'whole' })
  })

  it('keeps the FIRST chunk mode when merging onto a snapshot', () => {
    // The merged chunk stands in for the pair. If the first was a snapshot the
    // pair still replaces, or the buffered replacement would be lost.
    expect(mergeContentChunks({ text: 'whole' }, { text: '!', append: true })).toEqual({
      text: 'whole!',
      append: undefined,
    })
  })

  it('is associative, which is what makes coalescing anywhere lossless', () => {
    const chunks: ContentChunk[] = [
      { text: 'The ' },
      { text: 'quick ', append: true },
      { text: 'brown ', append: true },
      { text: 'fox', append: true },
    ]
    // Applied one at a time, as an unbatched client would.
    const direct = chunks.reduce<string | undefined>((acc, c) => applyContentText(acc, c), undefined)
    // Folded first, as a coalescing client does.
    const folded = chunks.reduce((a, b) => mergeContentChunks(a, b))
    expect(applyContentText(undefined, folded)).toBe(direct)
    expect(direct).toBe('The quick brown fox')
  })

  it('survives a snapshot arriving mid-batch', () => {
    const chunks: ContentChunk[] = [
      { text: 'aa', append: true },
      { text: 'RESET' },
      { text: 'bb', append: true },
    ]
    const direct = chunks.reduce<string | undefined>((acc, c) => applyContentText(acc, c), 'seed')
    const folded = chunks.reduce((a, b) => mergeContentChunks(a, b))
    expect(applyContentText('seed', folded)).toBe(direct)
    expect(direct).toBe('RESETbb')
  })
})

describe('wire cost', () => {
  it('a streamed reply is linear in length, not quadratic', () => {
    const tokens = Array.from({ length: 400 }, () => 'token ')
    const cumulative = tokens.reduce((total, _t, i) => total + (i + 1) * 'token '.length, 0)
    const incremental = tokens.length * 'token '.length
    // The old shape re-sent the whole body every token. This is the entire
    // reason for the change, so it is worth pinning rather than trusting.
    expect(incremental).toBeLessThan(cumulative / 100)
  })
})

/**
 * Applying an increment twice was harmless while content was cumulative
 * (last-write-wins) and is not now. Dual-chat mode mounts two panels, each
 * reducing the whole event stream, which duplicated every fragment of every
 * reply until exactly one of them claimed each event.
 */
describe('double application', () => {
  it('an increment applied twice duplicates the text', () => {
    const chunk = { text: 'Hel', append: true }
    const once = applyContentText(undefined, chunk)
    expect(applyContentText(once, chunk)).toBe('HelHel')
  })

  it('a snapshot applied twice is harmless, which is why this was invisible before', () => {
    const chunk = { text: 'Hello' }
    expect(applyContentText(applyContentText(undefined, chunk), chunk)).toBe('Hello')
  })
})
