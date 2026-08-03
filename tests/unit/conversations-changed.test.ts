/**
 * A chat started on the phone was invisible on the desktop until reload: the
 * sidebar learned about new chats only from a renderer-local bus that the
 * desktop's own ChatPanel fired, so another client's writes never surfaced.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppChannels } from '../../src/shared/ipc-channels'

const appIpc = readFileSync(join(__dirname, '../../src/main/ipc/app.ts'), 'utf8')
const sidebar = readFileSync(
  join(__dirname, '../../src/renderer/components/sidebar/Sidebar.tsx'),
  'utf8',
)

describe('CONVERSATIONS_CHANGED', () => {
  it('has a channel distinct from the renderer-local session bus', () => {
    expect(AppChannels.CONVERSATIONS_CHANGED).toBe('app:conversations-changed')
  })

  it('is emitted on both create and rename, so a phone-started chat surfaces', () => {
    const emits = appIpc.match(/host\.emit\(AppChannels\.CONVERSATIONS_CHANGED\)/g) ?? []
    expect(emits.length).toBe(2)
  })

  it('is subscribed by the sidebar, which is what refetches the project list', () => {
    expect(sidebar).toContain('onConversationsChanged')
  })
})
