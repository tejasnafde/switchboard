/**
 * The "Which chat should get this?" dialog links the picked chat before it
 * delivers review context, and delivers nothing when the link fails.
 */
import { describe, expect, it, vi } from 'vitest'
import { linkThenDeliver, pickNeedsLink } from '../../src/renderer/components/reviews/ask-chat-pick'

describe('linkThenDeliver', () => {
  it('links, then delivers', async () => {
    const order: string[] = []
    const failed = await linkThenDeliver(true, async () => { order.push('link'); return { ok: true } }, async () => { order.push('deliver') })
    expect(failed).toBeNull()
    expect(order).toEqual(['link', 'deliver'])
  })

  it('stops with the reason when the backend refuses the link', async () => {
    const deliver = vi.fn(async () => {})
    const failed = await linkThenDeliver(true, async () => ({ ok: false, message: "This pull request is not on the repository of that chat's project." }), deliver)
    expect(failed).toBe("This pull request is not on the repository of that chat's project.")
    expect(deliver).not.toHaveBeenCalled()
  })

  it('stops when the link call rejects', async () => {
    const deliver = vi.fn(async () => {})
    const failed = await linkThenDeliver(true, async () => { throw new Error('unknown channel') }, deliver)
    expect(failed).toBe('Could not link that chat; see the log.')
    expect(deliver).not.toHaveBeenCalled()
  })

  it('delivers without linking when the PR already has linked chats', async () => {
    const link = vi.fn(async () => ({ ok: true as const }))
    const deliver = vi.fn(async () => {})
    expect(await linkThenDeliver(false, link, deliver)).toBeNull()
    expect(link).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledOnce()
  })
})

describe('pickNeedsLink', () => {
  it('links a picked chat that is not linked, even when another chat is', () => {
    expect(pickNeedsLink([{ id: 'a' }], 'b')).toBe(true)
    expect(pickNeedsLink([], 'b')).toBe(true)
  })
  it('does not link a chat that is already linked', () => {
    expect(pickNeedsLink([{ id: 'a' }, { id: 'b' }], 'b')).toBe(false)
  })
})
