import { describe, expect, it } from 'vitest'
import { historyToItems, splitLegacyCachedItems } from '../../apps/mobile/src/lib/threadHistory'
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

  it('renders a task notification as its own row and keeps the typed remainder', () => {
    const items = historyToItems([
      message({
        id: 'n',
        content: '<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>\n<summary>Background command "Build" failed with exit code 2</summary>\n</task-notification>\nkeep going',
      }),
    ])
    expect(items).toEqual([
      {
        kind: 'synthetic',
        id: 'h-n-s0',
        part: { kind: 'task-notification', status: 'failed', summary: 'Background command "Build" failed with exit code 2', taskId: 'b1', outputFile: undefined },
      },
      { kind: 'user', id: 'h-n', text: 'keep going', at: 1, images: undefined },
    ])
  })

  it('keeps a typed displayBody that starts with a marker as the user bubble', () => {
    const typed = '[Request interrupted by user] why did you stop?'
    expect(historyToItems([message({ content: 'provider wire', displayBody: typed })])).toEqual([
      { kind: 'user', id: 'h-user-1', text: typed, at: 1, images: undefined },
    ])
  })

  it('splits history rows from a cache written before synthetic rows, and nothing else', () => {
    const live = { kind: 'user' as const, id: 'remote_1', text: '[Request interrupted by user] typed live', at: 2 }
    expect(splitLegacyCachedItems([
      { kind: 'user', id: 'h-old', text: '[Request interrupted by user]', at: 1 },
      live,
    ])).toEqual([
      { kind: 'synthetic', id: 'h-old-s0', part: { kind: 'interrupted', duringToolUse: false } },
      live,
    ])
  })
})
