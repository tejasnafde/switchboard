/**
 * Unit tests for `enrichMessagesWithDisplayBody` — the join that lets
 * persisted pill chips reappear on reload. JSONL is the source of truth
 * for content; the DB side-loads `display_body` + `pills_meta` keyed by
 * `(role='user', content)`.
 */
import { describe, it, expect } from 'vitest'
import { enrichMessagesWithDisplayBody } from '../../src/main/ipc/enrichDisplayBody'
import type { ChatMessage } from '../../src/shared/types'
import type { DisplayBodyEnrichment } from '../../src/main/db/database'

function userMsg(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 0 }
}
function assistantMsg(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 0 }
}

const samplePillsMeta = JSON.stringify({
  abc: { label: 'a.ts', kind: 'file' },
})

describe('enrichMessagesWithDisplayBody', () => {
  it('returns input unchanged when enrichments map is empty', () => {
    const messages = [userMsg('1', 'hi')]
    expect(enrichMessagesWithDisplayBody(messages, new Map())).toBe(messages)
  })

  it('attaches displayBody + parsed pillsMeta to a matching user message', () => {
    const messages = [userMsg('jsonl-1', 'expanded body')]
    const enrichments = new Map<string, DisplayBodyEnrichment>([
      ['expanded body', { displayBody: 'see [[pill:abc]]', pillsMeta: samplePillsMeta }],
    ])
    const out = enrichMessagesWithDisplayBody(messages, enrichments)
    expect(out[0].displayBody).toBe('see [[pill:abc]]')
    expect(out[0].pillsMeta).toEqual({ abc: { label: 'a.ts', kind: 'file' } })
  })

  it('does not mutate the original message objects', () => {
    const original = userMsg('jsonl-1', 'expanded body')
    const messages = [original]
    const enrichments = new Map<string, DisplayBodyEnrichment>([
      ['expanded body', { displayBody: 'x', pillsMeta: '{}' }],
    ])
    const out = enrichMessagesWithDisplayBody(messages, enrichments)
    expect(original.displayBody).toBeUndefined()
    expect(out[0]).not.toBe(original)
  })

  it('skips assistant messages even if their content matches a key', () => {
    const messages = [assistantMsg('a1', 'expanded body')]
    const enrichments = new Map<string, DisplayBodyEnrichment>([
      ['expanded body', { displayBody: 'x', pillsMeta: '{}' }],
    ])
    const out = enrichMessagesWithDisplayBody(messages, enrichments)
    expect(out[0].displayBody).toBeUndefined()
  })

  it('leaves user messages alone when content does not match', () => {
    const messages = [userMsg('1', 'no match')]
    const enrichments = new Map<string, DisplayBodyEnrichment>([
      ['something else', { displayBody: 'x', pillsMeta: '{}' }],
    ])
    const out = enrichMessagesWithDisplayBody(messages, enrichments)
    expect(out[0].displayBody).toBeUndefined()
  })

  it('drops enrichment when pills_meta JSON is corrupt', () => {
    const messages = [userMsg('1', 'expanded body')]
    const enrichments = new Map<string, DisplayBodyEnrichment>([
      ['expanded body', { displayBody: 'x', pillsMeta: '{not json' }],
    ])
    const out = enrichMessagesWithDisplayBody(messages, enrichments)
    expect(out[0].displayBody).toBeUndefined()
    expect(out[0].pillsMeta).toBeUndefined()
  })

  it('handles a mixed conversation with multiple enriched and untouched messages', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'first'),
      assistantMsg('a1', 'reply'),
      userMsg('u2', 'second'),
      userMsg('u3', 'third'),
    ]
    const enrichments = new Map<string, DisplayBodyEnrichment>([
      ['first', { displayBody: 'first display', pillsMeta: '{}' }],
      ['third', { displayBody: 'third display', pillsMeta: samplePillsMeta }],
    ])
    const out = enrichMessagesWithDisplayBody(messages, enrichments)
    expect(out[0].displayBody).toBe('first display')
    expect(out[1].displayBody).toBeUndefined()
    expect(out[2].displayBody).toBeUndefined()
    expect(out[3].displayBody).toBe('third display')
    expect(out[3].pillsMeta).toEqual({ abc: { label: 'a.ts', kind: 'file' } })
  })
})

describe('enrichMessagesWithDisplayBody (images)', () => {
  it('merges persisted images onto a JSONL user message with matching content', () => {
    const messages = [userMsg('jsonl-1', '<image>\n</image>')]
    const out = enrichMessagesWithDisplayBody(messages, new Map([
      ['<image>\n</image>', {
        images: JSON.stringify([{ url: 'data:image/png;base64,abc', mimeType: 'image/png', name: 'shot.png' }]),
      }],
    ]))

    expect(out[0].images).toEqual([
      { url: 'data:image/png;base64,abc', mimeType: 'image/png', name: 'shot.png' },
    ])
  })

  it('keeps existing display-body enrichment behavior while adding images', () => {
    const messages = [userMsg('jsonl-1', 'expanded body')]
    const out = enrichMessagesWithDisplayBody(messages, new Map([
      ['expanded body', {
        displayBody: 'see [[pill:abc]]',
        pillsMeta: samplePillsMeta,
        images: JSON.stringify([{ url: 'data:image/jpeg;base64,abc', mimeType: 'image/jpeg' }]),
      }],
    ]))

    expect(out[0].displayBody).toBe('see [[pill:abc]]')
    expect(out[0].pillsMeta).toEqual({ abc: { label: 'a.ts', kind: 'file' } })
    expect(out[0].images).toEqual([{ url: 'data:image/jpeg;base64,abc', mimeType: 'image/jpeg' }])
  })
})
