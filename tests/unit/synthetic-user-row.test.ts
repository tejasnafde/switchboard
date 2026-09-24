import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageBubble } from '../../src/renderer/components/chat/MessageBubble'
import { isSyntheticOnlyMessage } from '../../src/renderer/components/chat/SyntheticUserRow'
import type { ChatMessage } from '../../src/shared/types'

const NOTIFICATION = '<task-notification>\n<status>failed</status>\n<summary>Background command "Build" failed with exit code 2</summary>\n</task-notification>'
const IMAGE = { url: 'data:image/png;base64,AAA=', mimeType: 'image/png' }

const user = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1', role: 'user', content: NOTIFICATION, timestamp: 1, ...over,
})

const render = (message: ChatMessage) => renderToStaticMarkup(createElement(MessageBubble, { message, sessionId: 's1' }))
const idCount = (markup: string) => markup.split('data-message-id="m1"').length - 1

describe('synthetic user rows', () => {
  it('a synthetic-only message puts its id on the rendered row, once', () => {
    const markup = render(user({}))
    expect(markup).toContain('Background task failed: Build (exit 2)')
    expect(markup).not.toContain('&lt;task-notification')
    expect(idCount(markup)).toBe(1)
  })

  it('a message with a bubble carries the id on that bubble only', () => {
    expect(idCount(render(user({ content: `${NOTIFICATION}\nship it` })))).toBe(1)
    expect(idCount(render(user({ images: [IMAGE] })))).toBe(1)
  })

  it('images keep a synthetic message out of the synthetic-only set, so its You label shows', () => {
    expect(isSyntheticOnlyMessage(user({}))).toBe(true)
    expect(isSyntheticOnlyMessage(user({ images: [IMAGE] }))).toBe(false)
    expect(isSyntheticOnlyMessage(user({ content: 'hi' }))).toBe(false)
  })
})
