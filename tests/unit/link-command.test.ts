import { describe, it, expect } from 'vitest'
import { parseLinkCommand, pinLinkTarget, resolveLinkTarget } from '../../src/renderer/components/chat/link-command'

describe('parseLinkCommand', () => {
  it('reads a /link target', () => {
    expect(parseLinkCommand('/link Worker A')).toEqual({ ok: true, kind: 'link', target: 'Worker A' })
  })

  it('reads a trailing number as a possible budget', () => {
    expect(parseLinkCommand('/link Worker A 50')).toEqual({
      ok: true, kind: 'link', target: 'Worker A 50', budget: { target: 'Worker A', messages: 50 },
    })
  })

  it('needs a target for /link', () => {
    expect(parseLinkCommand('/link  ')).toMatchObject({ ok: false })
  })

  it('reads /unlink with and without a target', () => {
    expect(parseLinkCommand('/unlink Worker A')).toEqual({ ok: true, kind: 'unlink', target: 'Worker A' })
    expect(parseLinkCommand('/unlink')).toEqual({ ok: true, kind: 'unlink', target: null })
  })

  it('is not a link command otherwise', () => {
    expect(parseLinkCommand('/linked list')).toBeNull()
    expect(parseLinkCommand('please /link this')).toBeNull()
    expect(parseLinkCommand('/send-to a: b')).toBeNull()
  })
})

describe('resolveLinkTarget', () => {
  const sessions = [
    { id: 'me', title: 'Lead' },
    { id: 'w', title: 'Worker A' },
    { id: 'i', title: 'Issue 172' },
  ]
  const resolve = (body: string) => {
    const parsed = parseLinkCommand(body)
    if (!parsed?.ok || parsed.kind !== 'link') throw new Error('not a link')
    return resolveLinkTarget(parsed, sessions, 'me')
  }

  it('links with the default budget when no number is given', () => {
    expect(resolve('/link Worker A')).toEqual({ ok: true, id: 'w', title: 'Worker A' })
  })

  it('takes a trailing number as the budget', () => {
    expect(resolve('/link Worker A 50')).toEqual({ ok: true, id: 'w', title: 'Worker A', messages: 50 })
    expect(resolve('/link #w 7')).toEqual({ ok: true, id: 'w', title: 'Worker A', messages: 7 })
  })

  // A chat whose title ends in a number must stay reachable by that title.
  it('prefers a chat whose whole title is the text', () => {
    expect(resolve('/link Issue 172')).toEqual({ ok: true, id: 'i', title: 'Issue 172' })
    expect(resolve('/link Issue 172 30')).toEqual({ ok: true, id: 'i', title: 'Issue 172', messages: 30 })
  })

  it('refuses a budget out of range', () => {
    expect(resolve('/link Worker A 500')).toMatchObject({ ok: false })
    expect(resolve('/link Worker A 0')).toMatchObject({ ok: false })
  })
})

describe('pinLinkTarget', () => {
  const pick = { id: 'w', title: 'Worker A' }
  it('pins a picked title, keeping the budget', () => {
    expect(pinLinkTarget('/link Worker A', pick)).toBe('/link #w')
    expect(pinLinkTarget('/link Worker A 40', pick)).toBe('/link #w 40')
  })
  it('leaves a retargeted command alone', () => {
    expect(pinLinkTarget('/link Worker B', pick)).toBe('/link Worker B')
    expect(pinLinkTarget('/link Worker A', null)).toBe('/link Worker A')
  })
})
