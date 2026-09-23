import { describe, expect, it } from 'vitest'
import { threadPreviewLine } from '../../apps/mobile/src/lib/threadPreview'
import type { FeedItem } from '../../apps/mobile/src/stores/chat'

function assistantText(text: string, id = 'm1'): FeedItem {
  return { kind: 'text', id, text, stream: 'assistant', done: true }
}

describe('threadPreviewLine', () => {
  it('returns undefined for no items', () => {
    expect(threadPreviewLine([])).toBeUndefined()
  })

  it('ignores non-assistant text streams', () => {
    const items: FeedItem[] = [
      { kind: 'text', id: 'r1', text: '<agent_digest>Should not count</agent_digest>', stream: 'reasoning', done: true },
      { kind: 'text', id: 'p1', text: '<agent_digest>Should not count either</agent_digest>', stream: 'plan', done: true },
    ]
    expect(threadPreviewLine(items)).toBeUndefined()
  })

  it('prefers the digest from the latest assistant text item', () => {
    const items = [
      assistantText('<agent_digest>Reading files</agent_digest>', 'a1'),
      assistantText('<agent_digest>Writing tests</agent_digest>', 'a2'),
    ]
    expect(threadPreviewLine(items)).toBe('Writing tests')
  })

  it('falls back to a truncated raw preview when there is no digest', () => {
    const items = [assistantText('a'.repeat(120))]
    const preview = threadPreviewLine(items)
    expect(preview).toBeDefined()
    expect(preview!.length).toBe(70)
    expect(preview!.endsWith('…')).toBe(true)
  })

  it('skips a tool item and looks further back for the last assistant text', () => {
    const items: FeedItem[] = [
      assistantText('<agent_digest>Real status</agent_digest>', 'a1'),
      { kind: 'tool', id: 't1', toolName: 'Bash', input: {}, state: 'running' },
    ]
    expect(threadPreviewLine(items)).toBe('Real status')
  })

  it('finds a digest in an earlier message of the same turn when the newest assistant text (post-tool-call) has none', () => {
    // Regression (CodeRabbit, PR #105): Claude splits a turn into several
    // assistant text items at tool-call boundaries.
    const items: FeedItem[] = [
      { kind: 'user', id: 'u1', text: 'do the thing', at: 1 },
      assistantText('<agent_digest>Reading files</agent_digest> then running tests', 'a1'),
      { kind: 'tool', id: 't1', toolName: 'Bash', input: {}, state: 'done' },
      assistantText('Now running the test suite...', 'a2'),
    ]
    expect(threadPreviewLine(items)).toBe('Reading files')
  })

  it('shows no preview once a new user message starts a turn the agent has not replied to yet', () => {
    const items: FeedItem[] = [
      assistantText('<agent_digest>Done: tests green</agent_digest>', 'a1'),
      { kind: 'user', id: 'u2', text: 'thanks, now do one more thing', at: 2 },
    ]
    expect(threadPreviewLine(items)).toBeUndefined()
  })
})
