/**
 * Tool results out of the SDK's synthetic `user` messages.
 *
 * Regression: the Claude adapter never emitted `tool.completed` - Codex and
 * OpenCode both do - so a client keying a spinner on completion showed every
 * tool card spinning until the entire turn ended. On a long turn that reads as
 * "the spinner never goes away".
 */
import { describe, it, expect } from 'vitest'
import { extractToolResults } from '../../src/main/provider/adapters/claude-adapter'

describe('extractToolResults', () => {
  it('reads a string result', () => {
    const msg = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    }
    expect(extractToolResults(msg)).toEqual([{ toolId: 'toolu_1', output: 'ok', isError: false }])
  })

  it('joins a block-array result', () => {
    const msg = {
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
      },
    }
    expect(extractToolResults(msg)[0].output).toBe('line one\nline two')
  })

  it('flags an error result', () => {
    const msg = {
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }],
      },
    }
    expect(extractToolResults(msg)[0]).toMatchObject({ isError: true, output: 'boom' })
  })

  it('reads several results from one message', () => {
    // A parallel tool batch settles together.
    const msg = {
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: '1' },
          { type: 'tool_result', tool_use_id: 'b', content: '2' },
        ],
      },
    }
    expect(extractToolResults(msg).map((r) => r.toolId)).toEqual(['a', 'b'])
  })

  it('ignores non-tool_result blocks', () => {
    const msg = {
      message: { content: [{ type: 'text', text: 'hello' }, { type: 'image' }] },
    }
    expect(extractToolResults(msg)).toEqual([])
  })

  it('ignores a tool_result with no tool_use_id, which could not be matched anyway', () => {
    expect(extractToolResults({ message: { content: [{ type: 'tool_result', content: 'x' }] } })).toEqual([])
  })

  it('tolerates any shape without throwing', () => {
    expect(extractToolResults(null)).toEqual([])
    expect(extractToolResults(undefined)).toEqual([])
    expect(extractToolResults({})).toEqual([])
    expect(extractToolResults({ message: {} })).toEqual([])
    expect(extractToolResults({ message: { content: 'not an array' } })).toEqual([])
  })

  it('yields an empty output rather than dropping the result when content is missing', () => {
    // The card must still settle; an empty body is better than a stuck spinner.
    expect(extractToolResults({ message: { content: [{ type: 'tool_result', tool_use_id: 'z' }] } })).toEqual([
      { toolId: 'z', output: '', isError: false },
    ])
  })
})
