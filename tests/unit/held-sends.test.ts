/**
 * A message sent while its chat switches profile or is still opening is
 * queued, not refused. Regression: ChatPanel's handleSend answered it with a
 * red "Switching to ... Your draft is held. Send when ready." error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelHeldSend,
  cancelHeldSends,
  hasHeldSends,
  holdSend,
  moveHeldSends,
  resetHeldSendsForTests,
  sendMustWait,
  settleHeldSends,
  type HeldSendFn,
} from '../../src/renderer/services/held-sends'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { useDraftStore } from '../../src/renderer/stores/draft-store'
import { useChatWaitStore, type ChatWait } from '../../src/renderer/stores/chat-wait-store'

const SWITCHING: ChatWait = { label: 'Switching to Tejas...', pending: true }
const FAILED: ChatWait = { label: 'Could not switch profile: no auth', pending: false, error: true }
const ready = () => ({ opening: false, wait: undefined })

const revoked: string[] = []
let urls = 0

beforeEach(() => {
  resetHeldSendsForTests()
  urls = 0
  revoked.length = 0
  vi.stubGlobal('URL', {
    createObjectURL: (): string => `blob:held-${++urls}`,
    revokeObjectURL: (url: string): void => {
      revoked.push(url)
    },
  })
  useAgentStore.setState({ sessions: [] })
  useAgentStore.getState().addSession({ id: 's1', type: 'claude-code', status: 'idle' })
  useDraftStore.setState({ drafts: {}, pillsBySession: {}, imagesBySession: {} })
  useChatWaitStore.setState({ opening: {}, waits: {} })
})

const session = () => useAgentStore.getState().sessions.find((s) => s.id === 's1')!

function recorder(results: Array<{ accepted: true } | { accepted: false; error: string }> = []) {
  const calls: Array<{ message: string; delivery?: string; images?: number; origin?: string }> = []
  const send: HeldSendFn = async (message, delivery, images, extras) => {
    calls.push({ message, delivery, images: images?.length, origin: extras?.origin })
    return results.shift() ?? { accepted: true }
  }
  return { calls, send }
}

describe('sendMustWait', () => {
  it('waits while the chat opens or a switch is pending, not after a failure', () => {
    expect(sendMustWait(true, undefined)).toBe(true)
    expect(sendMustWait(false, SWITCHING)).toBe(true)
    expect(sendMustWait(false, FAILED)).toBe(false)
    expect(sendMustWait(false, undefined)).toBe(false)
  })
})

describe('held sends', () => {
  it('shows a held send as a local queued row', () => {
    const id = holdSend('s1', { message: 'hello' })
    expect(session().messages.map((m) => [m.id, m.content])).toEqual([[id, 'hello']])
    expect(session().queuedTurns?.[id]).toMatchObject({ local: true, text: 'hello' })
  })

  it('keeps the queued row over a backend seed and a stopped status', () => {
    const id = holdSend('s1', { message: 'hello' })
    useAgentStore.getState().setQueuedTurns('s1', [])
    useAgentStore.getState().trackQueuedTurnEvent({ type: 'status', threadId: 's1', status: 'stopped' } as never)
    expect(session().queuedTurns?.[id]?.local).toBe(true)
  })

  it('sends nothing while the switch is pending, then sends each once, in order', async () => {
    holdSend('s1', { message: 'first', extras: { origin: 'o1' } })
    holdSend('s1', { message: 'second', extras: { origin: 'o2' } })
    const { calls, send } = recorder()
    const refused = vi.fn()

    await settleHeldSends('s1', () => ({ opening: false, wait: SWITCHING }), send, refused)
    await settleHeldSends('s1', () => ({ opening: true, wait: undefined }), send, refused)
    expect(calls).toEqual([])

    await settleHeldSends('s1', ready, send, refused)
    // A second settle (another pane, a re-render) must not send again.
    await settleHeldSends('s1', ready, send, refused)

    // Queue delivery, so the second does not steer into the first one's turn.
    expect(calls).toEqual([
      { message: 'first', delivery: 'queue', images: undefined, origin: 'o1' },
      { message: 'second', delivery: 'queue', images: undefined, origin: 'o2' },
    ])
    expect(refused).not.toHaveBeenCalled()
    expect(session().messages).toEqual([])
    expect(session().queuedTurns).toEqual({})
    expect(useDraftStore.getState().drafts.s1).toBeUndefined()
  })

  it('returns the messages to the composer when the switch fails, without sending', async () => {
    holdSend('s1', { message: 'first' })
    holdSend('s1', { message: 'second' })
    const { calls, send } = recorder()

    await settleHeldSends('s1', () => ({ opening: false, wait: FAILED }), send, vi.fn())

    expect(calls).toEqual([])
    expect(useDraftStore.getState().drafts.s1).toBe('first\n\nsecond')
    expect(session().messages).toEqual([])
    expect(hasHeldSends('s1')).toBe(false)
  })

  it('puts a refused send and the ones after it back, and reports the error', async () => {
    holdSend('s1', { message: 'first' })
    holdSend('s1', { message: 'second' })
    holdSend('s1', { message: 'third' })
    const { calls, send } = recorder([{ accepted: true }, { accepted: false, error: 'too big' }])
    const refused = vi.fn()

    await settleHeldSends('s1', ready, send, refused)

    expect(calls.map((c) => c.message)).toEqual(['first', 'second'])
    expect(refused).toHaveBeenCalledWith('too big', false)
    expect(useDraftStore.getState().drafts.s1).toBe('second\n\nthird')
  })

  it('sends images and pills as they were given, and returns pill text expanded on failure', async () => {
    const file = { name: 'a.png', type: 'image/png' } as File
    holdSend('s1', {
      message: 'see FULL PILL TEXT',
      images: [{ file, previewUrl: 'blob:composer' }],
      extras: { displayBody: 'see [[pill:p1]]', pillsMeta: { p1: { label: 'x.ts', kind: 'file' } } },
    })
    // The row keeps its own preview: the composer revokes its own on acceptance.
    expect(session().messages[0].images?.[0].url).toBe('blob:held-1')
    expect(session().messages[0].displayBody).toBe('see [[pill:p1]]')

    await settleHeldSends('s1', () => ({ opening: false, wait: FAILED }), recorder().send, vi.fn())
    expect(useDraftStore.getState().drafts.s1).toBe('see FULL PILL TEXT')
    expect(useDraftStore.getState().imagesBySession.s1?.map((i) => [i.file, i.previewUrl])).toEqual([
      [file, 'blob:held-1'],
    ])
    expect(revoked).toEqual([])
  })

  it('revokes the row preview once the image is sent', async () => {
    const file = { name: 'a.png', type: 'image/png' } as File
    holdSend('s1', { message: 'pic', images: [{ file, previewUrl: 'blob:composer' }] })
    const { calls, send } = recorder()
    await settleHeldSends('s1', ready, send, vi.fn())
    expect(calls[0].images).toBe(1)
    expect(revoked).toEqual(['blob:held-1'])
  })

  it('Cancel takes one message back; the others still send', async () => {
    const first = holdSend('s1', { message: 'first' })
    holdSend('s1', { message: 'second' })
    expect(cancelHeldSend('s1', first)).toBe(true)
    expect(useDraftStore.getState().drafts.s1).toBe('first')
    expect(session().messages.map((m) => m.content)).toEqual(['second'])

    const { calls, send } = recorder()
    await settleHeldSends('s1', ready, send, vi.fn())
    expect(calls.map((c) => c.message)).toEqual(['second'])
  })

  it('Stop takes every held message back', async () => {
    holdSend('s1', { message: 'first' })
    holdSend('s1', { message: 'second' })
    expect(cancelHeldSends('s1')).toBe(true)
    expect(useDraftStore.getState().drafts.s1).toBe('first\n\nsecond')
    const { calls, send } = recorder()
    await settleHeldSends('s1', ready, send, vi.fn())
    expect(calls).toEqual([])
  })
})

describe('held sends across waits and panes', () => {
  it('a message held while the first one starts its agent goes out after the others', async () => {
    holdSend('s1', { message: 'first' })
    holdSend('s1', { message: 'second' })
    let wait: ChatWait | undefined
    const calls: string[] = []
    const send: HeldSendFn = async (message) => {
      calls.push(message)
      if (message === 'first') {
        // handleSend's startSession begins its own wait; the user sends again.
        wait = { label: 'Starting Claude...', pending: true }
        holdSend('s1', { message: 'third' })
        // The wait ends and the pane settles again while this loop still runs.
        wait = undefined
        await settleHeldSends('s1', () => ({ opening: false, wait }), send, vi.fn())
      }
      return { accepted: true }
    }
    await settleHeldSends('s1', () => ({ opening: false, wait }), send, vi.fn())
    expect(calls).toEqual(['first', 'second', 'third'])
  })

  it('a failed switch hands the messages back even with no pane to settle them', () => {
    holdSend('s1', { message: 'first' })
    useChatWaitStore.getState().begin('s1', 'Switching to Tejas...')
    useChatWaitStore.getState().fail('s1', 'Could not switch profile: no auth')
    expect(useDraftStore.getState().drafts.s1).toBe('first')
    expect(hasHeldSends('s1')).toBe(false)
  })

  it('reports a refused send whose delivery is unconfirmed', async () => {
    holdSend('s1', { message: 'first' })
    const refused = vi.fn()
    const send: HeldSendFn = async () => ({ accepted: false, error: 'timed out', delivery: 'ambiguous' })
    await settleHeldSends('s1', ready, send, refused)
    expect(refused).toHaveBeenCalledWith('timed out', true)
  })

  it('moves held messages to the live root id an open resolves to', async () => {
    useAgentStore.getState().addSession({ id: 'root', type: 'claude-code', status: 'idle' })
    holdSend('s1', { message: 'first' })
    moveHeldSends('s1', 'root')
    expect(hasHeldSends('s1')).toBe(false)
    expect(session().messages).toEqual([])
    const root = useAgentStore.getState().sessions.find((s) => s.id === 'root')!
    expect(root.messages.map((m) => m.content)).toEqual(['first'])
    const { calls, send } = recorder()
    await settleHeldSends('root', ready, send, vi.fn())
    expect(calls.map((c) => c.message)).toEqual(['first'])
  })
})

describe('ChatPanel send gate', () => {
  it('holds a send during a wait instead of refusing it', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/renderer/components/chat/ChatPanel.tsx', 'utf8')
    expect(source).not.toContain('Your draft is held')
    expect(source).toMatch(/if \(sendMustWait\(.*\)\) \{\s*holdSend\(sessionId/)
    expect(source).toContain('settleHeldSends(')
  })
})
