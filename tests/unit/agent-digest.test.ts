import { describe, expect, it } from 'vitest'
import { extractDigest, stripDigest } from '../../src/shared/agent-digest'

describe('extractDigest', () => {
  it('returns undefined for empty text', () => {
    expect(extractDigest('')).toBeUndefined()
  })

  it('returns undefined when no tag is present', () => {
    expect(extractDigest('Just some plain assistant text.')).toBeUndefined()
  })

  it('extracts a single complete tag, trimmed', () => {
    expect(extractDigest('<agent_digest>  Reading config files  </agent_digest>')).toBe(
      'Reading config files',
    )
  })

  it('extracts the tag from surrounding prose', () => {
    const text = 'Sure, let me start.\n<agent_digest>Writing tests</agent_digest>\nHere is the plan...'
    expect(extractDigest(text)).toBe('Writing tests')
  })

  it('returns the LAST complete tag when several are present', () => {
    const text =
      '<agent_digest>Step one</agent_digest> some prose ' +
      '<agent_digest>Step two</agent_digest> more prose ' +
      '<agent_digest>Done: all steps finished</agent_digest>'
    expect(extractDigest(text)).toBe('Done: all steps finished')
  })

  it('ignores an unclosed trailing tag and falls back to the last complete one', () => {
    const text = '<agent_digest>Step one</agent_digest> now streaming <agent_digest>Step tw'
    expect(extractDigest(text)).toBe('Step one')
  })

  it('returns undefined for an unclosed tag with nothing before it', () => {
    expect(extractDigest('<agent_digest>still typing')).toBeUndefined()
  })

  it('skips a whitespace-only digest body', () => {
    expect(extractDigest('<agent_digest>   </agent_digest>')).toBeUndefined()
  })

  it('skips an empty whitespace-only last tag and falls back to an earlier one', () => {
    const text = '<agent_digest>Real status</agent_digest> <agent_digest>   </agent_digest>'
    expect(extractDigest(text)).toBe('Real status')
  })

  it('caps the digest at about 120 chars with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const digest = extractDigest(`<agent_digest>${long}</agent_digest>`)
    expect(digest).toBeDefined()
    expect(digest!.length).toBe(120)
    expect(digest!.endsWith('…')).toBe(true)
    expect(digest!.startsWith('x'.repeat(119))).toBe(true)
  })

  it('does not cap a digest exactly at the limit', () => {
    const exact = 'x'.repeat(120)
    expect(extractDigest(`<agent_digest>${exact}</agent_digest>`)).toBe(exact)
  })

  it('handles multiline digest content by trimming outer whitespace only', () => {
    const text = '<agent_digest>\n  Line with inner detail\n</agent_digest>'
    expect(extractDigest(text)).toBe('Line with inner detail')
  })
})

describe('stripDigest', () => {
  it('returns falsy input unchanged', () => {
    expect(stripDigest('')).toBe('')
  })

  it('returns text unchanged when no tag is present', () => {
    expect(stripDigest('Just some plain text.')).toBe('Just some plain text.')
  })

  it('removes a single complete tag', () => {
    expect(stripDigest('Hello <agent_digest>Working</agent_digest> world')).toBe('Hello  world')
  })

  it('removes multiple complete tags', () => {
    const text =
      '<agent_digest>Step one</agent_digest>body one' +
      '<agent_digest>Step two</agent_digest>body two'
    expect(stripDigest(text)).toBe('body onebody two')
  })

  it('hides a fully unclosed trailing tag and its partial body', () => {
    expect(stripDigest('Working on it. <agent_digest>Writing te')).toBe('Working on it. ')
  })

  it('hides an unclosed tag with a partial close tag in progress', () => {
    expect(stripDigest('Working on it. <agent_digest>Writing tests</agent_dig')).toBe(
      'Working on it. ',
    )
  })

  it('hides a bare partial prefix of the open tag at the end of the text', () => {
    expect(stripDigest('Working on it. <agent_di')).toBe('Working on it. ')
  })

  it('hides the shortest partial prefix: a single trailing "<"', () => {
    expect(stripDigest('Working on it. <')).toBe('Working on it. ')
  })

  it('does not touch a "<" that is not followed by tag-prefix characters', () => {
    expect(stripDigest('if (x < 5) return')).toBe('if (x < 5) return')
  })

  it('does not touch an unrelated trailing angle-bracket tag', () => {
    expect(stripDigest('some <b>bold</b> text')).toBe('some <b>bold</b> text')
  })

  it('keeps prose between a complete tag and a later unclosed one', () => {
    const text = '<agent_digest>first</agent_digest> body text <agent_digest>second'
    expect(stripDigest(text)).toBe(' body text ')
  })

  it('progressively strips a tag as it streams in, character by character', () => {
    const full = 'Working on it. <agent_digest>Writing tests, 2 of 4 done</agent_digest>'
    const prefixesThatShouldAllHideTheTag = [
      'Working on it. <',
      'Working on it. <a',
      'Working on it. <agent_dig',
      'Working on it. <agent_digest>',
      'Working on it. <agent_digest>Writing',
      'Working on it. <agent_digest>Writing tests, 2 of 4 done',
      'Working on it. <agent_digest>Writing tests, 2 of 4 done</agent_dig',
    ]
    for (const partial of prefixesThatShouldAllHideTheTag) {
      expect(stripDigest(partial)).toBe('Working on it. ')
    }
    expect(stripDigest(full)).toBe('Working on it. ')
  })
})
