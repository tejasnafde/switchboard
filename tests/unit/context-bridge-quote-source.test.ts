// @vitest-environment jsdom
/** Cmd+L on a chat bubble stores the quoted chat and message on the pill, so the chip can open it later. */
import { afterEach, describe, expect, it } from 'vitest'
import { captureSelection } from '../../src/renderer/services/context-bridge'
import { useDraftStore } from '../../src/renderer/stores/draft-store'

function selectIn(node: Node): void {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

afterEach(() => {
  document.body.innerHTML = ''
  useDraftStore.getState().clearPills('chat-1')
})

describe('Cmd+L quote source', () => {
  it('names the chat and the message the selection starts in', () => {
    document.body.innerHTML = `
      <div data-session-id="chat-1" data-context-source="chat-message">
        <div data-message-id="msg-7" data-message-role="assistant"><p id="text">the cache key</p></div>
      </div>`
    selectIn(document.getElementById('text')!.firstChild!)
    expect(captureSelection()).toBe(true)
    const pill = useDraftStore.getState().pillsBySession['chat-1']?.at(-1)
    expect(pill).toMatchObject({
      kind: 'chat-message',
      sourceConversationId: 'chat-1',
      sourceMessageId: 'msg-7',
    })
  })
})
