import { describe, expect, it } from 'vitest'
import { plainPreviewText, turnPreviewLine, type PreviewMessage } from '../../src/shared/turn-preview'

function user(text: string): PreviewMessage {
  return { text, isAssistant: false, isUser: true }
}

function assistant(text: string): PreviewMessage {
  return { text, isAssistant: true, isUser: false }
}

describe('turnPreviewLine', () => {
  it('returns undefined for no messages', () => {
    expect(turnPreviewLine([])).toBeUndefined()
  })

  it('returns undefined when there is no assistant message yet', () => {
    expect(turnPreviewLine([user('do the thing')])).toBeUndefined()
  })

  it('returns the digest from the newest assistant message', () => {
    const messages = [
      user('start'),
      assistant('<agent_digest>Reading files</agent_digest>'),
    ]
    expect(turnPreviewLine(messages)).toBe('Reading files')
  })

  it('finds a digest in an EARLIER assistant message of the same turn when the newest has none', () => {
    // Regression (CodeRabbit, PR #105): Claude splits a turn into several
    // messages at tool calls. The message right after a tool call often
    // carries no digest of its own yet - the digest from an earlier
    // message in the SAME turn should still win over a raw fallback.
    const messages = [
      user('start'),
      assistant('<agent_digest>Reading files</agent_digest> then I will run the tests'),
      assistant('Now running the test suite...'), // no digest yet
    ]
    expect(turnPreviewLine(messages)).toBe('Reading files')
  })

  it('prefers the newest digest when multiple messages in the turn report one', () => {
    const messages = [
      user('start'),
      assistant('<agent_digest>Step one</agent_digest>'),
      assistant('<agent_digest>Step two</agent_digest>'),
    ]
    expect(turnPreviewLine(messages)).toBe('Step two')
  })

  it('falls back to a truncated raw preview of the newest assistant message when the turn has no digest', () => {
    const messages = [
      user('start'),
      assistant('Reading the config file now'),
      assistant('Now running the test suite'),
    ]
    expect(turnPreviewLine(messages)).toBe('Now running the test suite')
  })

  it('does not leak a digest from a PREVIOUS turn into the current one', () => {
    const messages = [
      user('first task'),
      assistant('<agent_digest>Old digest, done</agent_digest>'),
      user('second task'),
      assistant('Working on the second task now'), // no digest in this turn
    ]
    expect(turnPreviewLine(messages)).toBe('Working on the second task now')
  })

  it('does not use raw text from a previous turn either, once a new turn has started with no assistant reply yet', () => {
    const messages = [
      user('first task'),
      assistant('<agent_digest>Old digest, done</agent_digest> and some more prose'),
      user('second task'),
    ]
    expect(turnPreviewLine(messages)).toBeUndefined()
  })

  it('treats the whole array as the turn when there is no user message', () => {
    const messages = [
      assistant('Reading the config file now'),
      assistant('<agent_digest>Found it</agent_digest>'),
    ]
    expect(turnPreviewLine(messages)).toBe('Found it')
  })

  it('skips an empty assistant message and looks further back within the turn', () => {
    const messages = [
      user('start'),
      assistant('<agent_digest>Real status</agent_digest>'),
      assistant(''),
    ]
    expect(turnPreviewLine(messages)).toBe('Real status')
  })

  it('truncates a long raw fallback to about 70 chars with an ellipsis', () => {
    const long = 'a'.repeat(120)
    const messages = [user('start'), assistant(long)]
    const preview = turnPreviewLine(messages)
    expect(preview).toBeDefined()
    expect(preview!.length).toBe(70)
    expect(preview!.endsWith('…')).toBe(true)
  })

  it('hides a streaming partial tag from the raw fallback', () => {
    const messages = [user('start'), assistant('Working on it. <agent_di')]
    expect(turnPreviewLine(messages)).toBe('Working on it.')
  })
})

describe('plainPreviewText', () => {
  it('drops inline code, bold, italic and link markup but keeps the words', () => {
    expect(plainPreviewText('`pos_gatepass` is a **column**, see [docs](https://x.y) and _this_'))
      .toBe('pos_gatepass is a column, see docs and this')
  })

  it('drops fenced code, including a block that is still streaming', () => {
    expect(plainPreviewText('Fixed it:\n```ts\nconst a = 1\n```\nDone')).toBe('Fixed it: Done')
    expect(plainPreviewText('Running:\n```sh\nnpm te')).toBe('Running:')
  })

  it('drops heading, quote and list markers and joins lines', () => {
    expect(plainPreviewText('## Summary\n> note\n- one\n1. two')).toBe('Summary note one two')
  })

  it('leaves snake_case and multiplication alone', () => {
    expect(plainPreviewText('set max_retry_count to 2 * 3')).toBe('set max_retry_count to 2 * 3')
  })

  it('is applied to the raw fallback preview', () => {
    expect(turnPreviewLine([{ text: 'The counts mean **projects**', isAssistant: true, isUser: false }]))
      .toBe('The counts mean projects')
  })
})
