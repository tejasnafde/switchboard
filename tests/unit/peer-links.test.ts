import { describe, it, expect } from 'vitest'
import {
  PeerLinkBook,
  peerLinkLabel,
  peerLinksBannerText,
  PEER_LINK_MESSAGE_BUDGET,
  PEER_LINK_WINDOW_MS,
  type PeerLinkView,
} from '../../src/shared/peer-links'
import { PeerAgentSendGuard } from '../../src/shared/peer-messaging'

const T0 = 1_000_000

describe('PeerLinkBook lifecycle', () => {
  it('links two sessions in either order, and unlinks them', () => {
    const book = new PeerLinkBook()
    expect(book.link('a', 'b', 'user', T0)).toEqual({ ok: true, created: true })
    expect(book.isLinked('a', 'b')).toBe(true)
    expect(book.isLinked('b', 'a')).toBe(true)
    expect(book.unlink('b', 'a')).toEqual(['a'])
    expect(book.isLinked('a', 'b')).toBe(false)
  })

  it('reports a relink as renewing, not creating', () => {
    const book = new PeerLinkBook()
    book.link('a', 'b', 'user', T0)
    expect(book.link('b', 'a', 'user', T0)).toEqual({ ok: true, created: false })
    expect(book.linksOf('a')).toHaveLength(1)
  })

  it('refuses a link the agent asks for', () => {
    const book = new PeerLinkBook()
    const result = book.link('a', 'b', 'agent', T0)
    expect(result.ok).toBe(false)
    expect(book.isLinked('a', 'b')).toBe(false)
  })

  it('refuses a session linked with itself', () => {
    expect(new PeerLinkBook().link('a', 'a', 'user', T0).ok).toBe(false)
  })

  it('unlinks everything when no peer is named', () => {
    const book = new PeerLinkBook()
    book.link('hub', 'a', 'user', T0)
    book.link('hub', 'b', 'user', T0)
    book.link('a', 'b', 'user', T0)
    expect(book.unlink('hub').sort()).toEqual(['a', 'b'])
    expect(book.linksOf('hub')).toEqual([])
    // An edge the hub was not on survives.
    expect(book.isLinked('a', 'b')).toBe(true)
  })

  // Stop and archive both land here.
  it('drops every edge of a removed session and reports whom it touched', () => {
    const book = new PeerLinkBook()
    book.link('hub', 'a', 'user', T0)
    book.link('hub', 'b', 'user', T0)
    expect(book.removeSession('a')).toEqual(['hub'])
    expect(book.isLinked('hub', 'a')).toBe(false)
    expect(book.isLinked('hub', 'b')).toBe(true)
    expect(book.removeSession('nobody')).toEqual([])
  })
})

describe('a hub with three edges', () => {
  const hub = () => {
    const book = new PeerLinkBook()
    for (const w of ['w1', 'w2', 'w3']) book.link('hub', w, 'user', T0)
    return book
  }

  it('lists each edge for the hub and only the hub for a worker', () => {
    const book = hub()
    expect(book.linksOf('hub').map((l) => l.peerThreadId).sort()).toEqual(['w1', 'w2', 'w3'])
    expect(book.linksOf('w1').map((l) => l.peerThreadId)).toEqual(['hub'])
  })

  it('does not link the workers with each other', () => {
    const book = hub()
    expect(book.isLinked('w1', 'w2')).toBe(false)
    // An unlinked pair is left to the ordinary agent limits.
    expect(book.checkSend('w1', 'w2', T0)).toEqual({ linked: false })
  })

  it('budgets each edge on its own', () => {
    const book = hub()
    for (let i = 0; i < PEER_LINK_MESSAGE_BUDGET; i++) expect(book.checkSend('hub', 'w1', T0)).toEqual({ linked: true, ok: true })
    expect(book.checkSend('hub', 'w1', T0)).toMatchObject({ ok: false, reason: 'link-budget' })
    expect(book.checkSend('hub', 'w2', T0)).toEqual({ linked: true, ok: true })
  })
})

describe('edge budget', () => {
  it('counts both directions together', () => {
    const book = new PeerLinkBook(4)
    book.link('a', 'b', 'user', T0)
    book.checkSend('a', 'b', T0)
    book.checkSend('b', 'a', T0)
    book.checkSend('a', 'b', T0)
    book.checkSend('b', 'a', T0)
    const refused = book.checkSend('a', 'b', T0)
    expect(refused).toMatchObject({ linked: true, ok: false, reason: 'link-budget' })
    if (!refused.linked || refused.ok) throw new Error('expected a refusal')
    // Addressed to the model: what to do, and that the user can renew it.
    expect(refused.message).toMatch(/summarise/i)
    expect(refused.message).toMatch(/relink|type in either chat/i)
  })

  it('closes after the window even with messages left', () => {
    const book = new PeerLinkBook()
    book.link('a', 'b', 'user', T0)
    expect(book.checkSend('a', 'b', T0 + PEER_LINK_WINDOW_MS - 1)).toEqual({ linked: true, ok: true })
    expect(book.checkSend('a', 'b', T0 + PEER_LINK_WINDOW_MS)).toMatchObject({ ok: false, reason: 'link-expired' })
  })

  it('is renewed by a human message in EITHER session of the edge', () => {
    for (const human of ['a', 'b']) {
      const book = new PeerLinkBook(2)
      book.link('a', 'b', 'user', T0)
      book.checkSend('a', 'b', T0)
      book.checkSend('b', 'a', T0)
      expect(book.checkSend('a', 'b', T0)).toMatchObject({ linked: true, ok: false })
      expect(book.humanMessage(human, T0 + PEER_LINK_WINDOW_MS)).toEqual([human === 'a' ? 'b' : 'a'])
      expect(book.checkSend('a', 'b', T0 + PEER_LINK_WINDOW_MS)).toEqual({ linked: true, ok: true })
    }
  })

  it('renews every edge of a hub when the user types in it, and only the touched edge from a worker', () => {
    const book = new PeerLinkBook(1)
    for (const w of ['w1', 'w2']) {
      book.link('hub', w, 'user', T0)
      book.checkSend('hub', w, T0)
    }
    book.humanMessage('w1', T0)
    expect(book.checkSend('hub', 'w1', T0)).toEqual({ linked: true, ok: true })
    expect(book.checkSend('hub', 'w2', T0)).toMatchObject({ ok: false })
    book.humanMessage('hub', T0)
    expect(book.linksOf('hub').every((l) => l.used === 0)).toBe(true)
  })

  it('gives back a charged message when delivery fails', () => {
    const book = new PeerLinkBook(1)
    book.link('a', 'b', 'user', T0)
    book.checkSend('a', 'b', T0)
    book.release('a', 'b')
    expect(book.checkSend('a', 'b', T0)).toEqual({ linked: true, ok: true })
  })

  it('reports used, budget and the window end', () => {
    const book = new PeerLinkBook()
    book.link('a', 'b', 'user', T0)
    book.checkSend('a', 'b', T0)
    expect(book.linksOf('a')).toEqual([{ peerThreadId: 'b', used: 1, budget: PEER_LINK_MESSAGE_BUDGET, expiresAt: T0 + PEER_LINK_WINDOW_MS }])
  })
})

// The registry consults the link book first and the ordinary agent guard only
// when the pair is unlinked. The guard itself is unchanged, so a linked
// session's hop depth still binds everywhere its links do not reach.
describe('the third-session hop limit', () => {
  it('still refuses a worker that is acting on the hub passing it to an unlinked session', () => {
    const book = new PeerLinkBook()
    const guard = new PeerAgentSendGuard()
    book.link('hub', 'w1', 'user', T0)
    // w1 is at depth 1 after the hub's agent send reached it.
    expect(book.checkSend('w1', 'hub', T0)).toEqual({ linked: true, ok: true })
    expect(book.checkSend('w1', 'outsider', T0)).toEqual({ linked: false })
    expect(guard.check({ fromThreadId: 'w1', senderDepth: 1 }, T0)).toMatchObject({ ok: false, reason: 'hop-depth' })
  })
})

describe('banner text', () => {
  const view = (title: string, used: number, expiresAt = T0 + PEER_LINK_WINDOW_MS): PeerLinkView =>
    ({ peerThreadId: title, title, used, budget: 20, expiresAt })

  it('names each link and its count', () => {
    expect(peerLinksBannerText([view('Worker A', 7), view('Worker B', 2)], T0))
      .toBe('Linked with Worker A (7 of 20), Worker B (2 of 20)')
  })

  it('collapses to a count once there are several', () => {
    expect(peerLinksBannerText([view('A', 0), view('B', 0), view('C', 0)], T0)).toBe('Linked with 3 sessions')
  })

  it('says when a link is spent', () => {
    expect(peerLinkLabel(view('A', 20), T0)).toBe('A (limit reached)')
    expect(peerLinkLabel(view('A', 3, T0), T0)).toBe('A (time up)')
  })
})
