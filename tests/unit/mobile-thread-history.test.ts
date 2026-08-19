import { describe, expect, it } from 'vitest'
import { historyToItems } from '../../apps/mobile/src/lib/threadHistory'
import type { ChatMessage } from '../../src/shared/types'

const message = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'user-1', role: 'user', content: '', timestamp: 1, ...over,
})

describe('mobile thread history', () => {
  it('uses displayBody, keeps images, and filters recognized synthetic context', () => {
    const items = historyToItems([
      message({
        content: 'provider wrapper\n\nvisible',
        displayBody: 'visible',
        images: [{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }],
      }),
      message({
        id: 'synthetic',
        content: '<environment_context>\n<cwd>/repo</cwd>\n</environment_context>',
      }),
    ])
    expect(items).toEqual([
      {
        kind: 'user', id: 'h-user-1', text: 'visible', at: 1,
        images: ['data:image/png;base64,AAA'],
      },
    ])
  })
})
