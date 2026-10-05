import { describe, it, expect } from 'vitest'
import { parseLinkCommand, pinLinkTarget, resolveLinkTarget } from '../../src/renderer/components/chat/link-command'

const HOUR = 60 * 60_000

describe('parseLinkCommand', () => {
  it('reads a /link target', () => {
    expect(parseLinkCommand('/link Worker A')).toEqual({ ok: true, kind: 'link', target: 'Worker A', splits: [] })
  })

  it('reads a trailing number as a possible budget', () => {
    expect(parseLinkCommand('/link Worker A 50')).toEqual({
      ok: true, kind: 'link', target: 'Worker A 50', splits: [{ target: 'Worker A', messages: 50, tail: '50' }],
    })
  })

  it('reads a trailing time, with or without a budget before it', () => {
    expect(parseLinkCommand('/link Worker A 2h')).toMatchObject({
      splits: [{ target: 'Worker A', windowMs: 2 * HOUR, tail: '2h' }],
    })
    expect(parseLinkCommand('/link Worker A 100 90m')).toMatchObject({
      splits: [
        { target: 'Worker A 100', windowMs: 90 * 60_000, tail: '90m' },
        { target: 'Worker A', messages: 100, windowMs: 90 * 60_000, tail: '100 90m' },
      ],
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

  it('takes a time in minutes or hours, with or without a budget', () => {
    expect(resolve('/link Worker A 45m')).toEqual({ ok: true, id: 'w', title: 'Worker A', windowMs: 45 * 60_000 })
    expect(resolve('/link Worker A 4h')).toEqual({ ok: true, id: 'w', title: 'Worker A', windowMs: 4 * HOUR })
    expect(resolve('/link Worker A 100 4h')).toEqual({ ok: true, id: 'w', title: 'Worker A', messages: 100, windowMs: 4 * HOUR })
  })

  it('refuses a time outside 10 minutes to 24 hours, naming the range', () => {
    expect(resolve('/link Worker A 10m')).toMatchObject({ ok: true, windowMs: 10 * 60_000 })
    expect(resolve('/link Worker A 24h')).toMatchObject({ ok: true, windowMs: 24 * HOUR })
    expect(resolve('/link Worker A 9m')).toEqual({ ok: false, error: 'A link lasts 10 minutes to 24 hours.' })
    expect(resolve('/link Worker A 25h')).toEqual({ ok: false, error: 'A link lasts 10 minutes to 24 hours.' })
  })

  it('keeps a trailing time or number that is part of a chat title', () => {
    const titled = [...sessions, { id: 's', title: 'Sprint 2h' }]
    const parse = (body: string) => {
      const parsed = parseLinkCommand(body)
      if (!parsed?.ok || parsed.kind !== 'link') throw new Error('not a link')
      return resolveLinkTarget(parsed, titled, 'me')
    }
    expect(parse('/link Sprint 2h')).toEqual({ ok: true, id: 's', title: 'Sprint 2h' })
    expect(parse('/link Sprint 2h 4h')).toEqual({ ok: true, id: 's', title: 'Sprint 2h', windowMs: 4 * HOUR })
    expect(parse('/link Issue 172 4h')).toEqual({ ok: true, id: 'i', title: 'Issue 172', windowMs: 4 * HOUR })
    expect(parse('/link Issue 172 50 4h')).toEqual({ ok: true, id: 'i', title: 'Issue 172', messages: 50, windowMs: 4 * HOUR })
  })
})

describe('pinLinkTarget', () => {
  const pick = { id: 'w', title: 'Worker A' }
  it('pins a picked title, keeping the budget', () => {
    expect(pinLinkTarget('/link Worker A', pick)).toBe('/link #w')
    expect(pinLinkTarget('/link Worker A 40', pick)).toBe('/link #w 40')
    expect(pinLinkTarget('/link Worker A 4h', pick)).toBe('/link #w 4h')
    expect(pinLinkTarget('/link Worker A 40 4h', pick)).toBe('/link #w 40 4h')
  })
  it('leaves a retargeted command alone', () => {
    expect(pinLinkTarget('/link Worker B', pick)).toBe('/link Worker B')
    expect(pinLinkTarget('/link Worker A', null)).toBe('/link Worker A')
  })
})
