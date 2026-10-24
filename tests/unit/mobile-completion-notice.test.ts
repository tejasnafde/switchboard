/**
 * The local "Done" notice on the Expo app: when a turn end notifies, and when
 * the app being in front, the demo, a backend push or a repeat holds it back.
 */
import { describe, it, expect, vi } from 'vitest'
import type { RuntimeEvent } from '@shared/provider-events'
import { DEMO_CONNECTION_ID } from '@shared/phone-demo/phone-demo'
import {
  MAX_REMEMBERED_TURNS,
  completionNoticeBody,
  createCompletionNotifier,
  type CompletionNoticeDeps,
} from '../../apps/mobile/src/lib/completion-notice'

function done(turnId?: string, durationMs?: number): RuntimeEvent {
  return { type: 'turn.completed', threadId: 't1', turnId, durationMs } as RuntimeEvent
}

function setup(overrides: Partial<CompletionNoticeDeps> = {}) {
  const post = vi.fn(async () => true)
  const notify = createCompletionNotifier({ appActive: () => false, pushCovers: () => false, post, ...overrides })
  return { notify, post }
}

describe('completion notice', () => {
  it('posts Done with a payload a tap can route', async () => {
    const { notify, post } = setup()
    expect(await notify('mac', done('turn-1', 4200))).toBe(true)
    expect(post).toHaveBeenCalledWith({
      title: 'Switchboard',
      body: 'Done in 4.2s',
      data: { threadId: 't1', kind: 'done', clientRef: 'mac' },
    })
  })

  it('says Done without a duration', () => {
    expect(completionNoticeBody(undefined)).toBe('Done')
    expect(completionNoticeBody(0)).toBe('Done')
    expect(completionNoticeBody(125_000)).toBe('Done in 2m 5s')
  })

  it('stays quiet while the app is in front', async () => {
    const { notify, post } = setup({ appActive: () => true })
    expect(await notify('mac', done('turn-1'))).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('stays quiet when the backend push covers the turn', async () => {
    const pushCovers = vi.fn(() => true)
    const { notify, post } = setup({ pushCovers })
    expect(await notify('mac', done('turn-1'))).toBe(false)
    expect(pushCovers).toHaveBeenCalledWith('mac', 't1')
    expect(post).not.toHaveBeenCalled()
  })

  it('ignores other events, a blank thread and the demo', async () => {
    const { notify, post } = setup()
    expect(await notify('mac', { type: 'turn.started', threadId: 't1' } as RuntimeEvent)).toBe(false)
    expect(await notify('mac', { type: 'turn.completed', threadId: ' ' } as RuntimeEvent)).toBe(false)
    expect(await notify(DEMO_CONNECTION_ID, done('turn-1'))).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('posts a turn once, and again after a failed post', async () => {
    const post = vi.fn<CompletionNoticeDeps['post']>().mockResolvedValueOnce(false).mockResolvedValue(true)
    const { notify } = setup({ post })
    expect(await notify('mac', done('turn-1'))).toBe(false)
    expect(await notify('mac', done('turn-1'))).toBe(true)
    expect(await notify('mac', done('turn-1'))).toBe(false)
    expect(await notify('vm', done('turn-1'))).toBe(true)
    expect(post).toHaveBeenCalledTimes(3)
  })

  it('posts every turn end that has no turn id', async () => {
    const { notify, post } = setup()
    await notify('mac', done())
    await notify('mac', done())
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('forgets the oldest turn past the cap', async () => {
    const { notify, post } = setup()
    for (let i = 0; i <= MAX_REMEMBERED_TURNS; i++) await notify('mac', done(`turn-${i}`))
    expect(await notify('mac', done('turn-0'))).toBe(true)
    expect(post).toHaveBeenCalledTimes(MAX_REMEMBERED_TURNS + 2)
  })
})
