import { describe, it, expect } from 'vitest'
import {
  formatUndeliveredMarker,
  parseUndeliveredMarker,
  PeerLinkBook,
  peerLinkBudgetProblem,
  peerLinkLabel,
  peerLinksBannerText,
  peerLinkSpentText,
  peerUndeliveredHeading,
  peerUndeliveredId,
  PEER_LINK_EXTEND_MESSAGES,
  PEER_LINK_MAX_MESSAGES,
  PEER_LINK_MESSAGE_BUDGET,
  PEER_LINK_WINDOW_MS,
  formatPeerLinkDuration,
  formatPeerLinkTimeLeft,
  parsePeerLinkDuration,
  peerLinkDefaultWindow,
  peerLinkWindowProblem,
  PEER_LINK_MAX_WINDOW_MS,
  PEER_LINK_MIN_WINDOW_MS,
  PEER_UNDELIVERED_MARKER_PREFIX,
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
    // Addressed to a model nobody may be watching: it was not delivered, keep
    // going, and carry the message into the final reply.
    expect(refused.message).toMatch(/NOT delivered/)
    expect(refused.message).toMatch(/keep working/i)
    expect(refused.message).toMatch(/final reply/i)
  })

  it('reports the first refusal after a run-out once, until the edge is renewed', () => {
    const book = new PeerLinkBook(1)
    book.link('a', 'b', 'user', T0)
    book.checkSend('a', 'b', T0)
    expect(book.checkSend('a', 'b', T0)).toMatchObject({ ok: false, firstRefusal: true })
    expect(book.checkSend('b', 'a', T0)).toMatchObject({ ok: false, firstRefusal: false })
    book.renew('a', 'b', T0)
    book.checkSend('a', 'b', T0)
    expect(book.checkSend('a', 'b', T0)).toMatchObject({ ok: false, firstRefusal: true })
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

  it('gives a charge back only to the edge that took it', () => {
    const book = new PeerLinkBook(1)
    book.link('a', 'b', 'user', T0)
    const first = book.edgeId('a', 'b')
    book.checkSend('a', 'b', T0)
    book.unlink('a', 'b')
    book.link('a', 'b', 'user', T0)
    expect(book.edgeId('a', 'b')).not.toBe(first)
    book.checkSend('a', 'b', T0)
    book.release('a', 'b', first!)
    expect(book.linksOf('a')[0].used).toBe(1)
    // A relink of a live edge renews it in place.
    const current = book.edgeId('a', 'b')
    book.link('b', 'a', 'user', T0)
    expect(book.edgeId('a', 'b')).toBe(current)
    expect(book.edgeId('a', 'c')).toBeNull()
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
    expect(book.linksOf('a')).toEqual([{ peerThreadId: 'b', used: 1, budget: PEER_LINK_MESSAGE_BUDGET, expiresAt: T0 + PEER_LINK_WINDOW_MS, windowMs: PEER_LINK_WINDOW_MS }])
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
    ({ peerThreadId: title, title, used, budget: 20, expiresAt, windowMs: PEER_LINK_WINDOW_MS })

  it('names each link, its count and the time left', () => {
    expect(peerLinksBannerText([view('Worker A', 7), view('Worker B', 2, T0 + (3 * 60 + 12) * 60_000)], T0))
      .toBe('Linked with Worker A · 7 of 20 · 30m left, Worker B · 2 of 20 · 3h 12m left')
  })

  it('collapses to a count once there are several', () => {
    expect(peerLinksBannerText([view('A', 0), view('B', 0), view('C', 0)], T0)).toBe('Linked with 3 sessions')
  })

  it('says when a link is spent', () => {
    expect(peerLinkLabel(view('A', 20), T0)).toBe('A · limit reached')
    expect(peerLinkLabel(view('A', 3, T0), T0)).toBe('A · time up')
  })
})

describe('per-link budget', () => {
  it('takes the budget the user chose', () => {
    const book = new PeerLinkBook()
    book.link('a', 'b', 'user', T0, 3)
    expect(book.linksOf('a')[0].budget).toBe(3)
    for (let i = 0; i < 3; i++) book.checkSend('a', 'b', T0)
    expect(book.checkSend('a', 'b', T0)).toMatchObject({ ok: false, reason: 'link-budget' })
  })

  it('accepts 1 to the maximum and nothing else', () => {
    expect(peerLinkBudgetProblem(1)).toBeNull()
    expect(peerLinkBudgetProblem(PEER_LINK_MAX_MESSAGES)).toBeNull()
    for (const bad of [0, -1, 1.5, PEER_LINK_MAX_MESSAGES + 1, Number.NaN]) expect(peerLinkBudgetProblem(bad)).not.toBeNull()
    const book = new PeerLinkBook()
    expect(book.link('a', 'b', 'user', T0, PEER_LINK_MAX_MESSAGES + 1).ok).toBe(false)
    expect(book.isLinked('a', 'b')).toBe(false)
  })

  it('keeps the chosen budget when a human message renews the edge', () => {
    const book = new PeerLinkBook()
    book.link('a', 'b', 'user', T0, 50)
    book.checkSend('a', 'b', T0)
    book.humanMessage('a', T0)
    expect(book.linksOf('a')[0]).toMatchObject({ used: 0, budget: 50 })
  })
})

describe('extend', () => {
  it('adds messages and restarts the window, keeping what was used', () => {
    const book = new PeerLinkBook(2)
    book.link('a', 'b', 'user', T0)
    book.checkSend('a', 'b', T0)
    book.checkSend('a', 'b', T0)
    expect(book.extend('b', 'a', 'user', T0 + PEER_LINK_WINDOW_MS)).toEqual({ ok: true, created: false })
    expect(book.linksOf('a')[0]).toEqual({
      peerThreadId: 'b', used: 2, budget: 2 + PEER_LINK_EXTEND_MESSAGES, expiresAt: T0 + 2 * PEER_LINK_WINDOW_MS,
      windowMs: PEER_LINK_WINDOW_MS,
    })
    expect(book.checkSend('a', 'b', T0 + PEER_LINK_WINDOW_MS)).toEqual({ linked: true, ok: true })
  })

  it('never passes the maximum, and refuses once there with nothing left', () => {
    const book = new PeerLinkBook()
    book.link('a', 'b', 'user', T0, PEER_LINK_MAX_MESSAGES - 5)
    book.extend('a', 'b', 'user', T0)
    expect(book.linksOf('a')[0].budget).toBe(PEER_LINK_MAX_MESSAGES)
    for (let i = 0; i < PEER_LINK_MAX_MESSAGES; i++) book.checkSend('a', 'b', T0)
    expect(book.extend('a', 'b', 'user', T0)).toMatchObject({ ok: false })
  })

  it('is the user\'s alone, and only for a linked pair', () => {
    const book = new PeerLinkBook()
    book.link('a', 'b', 'user', T0)
    expect(book.extend('a', 'b', 'agent', T0).ok).toBe(false)
    expect(book.extend('a', 'c', 'user', T0).ok).toBe(false)
  })
})

// There is no cap on links per session: a hub may hold one edge per worker.
describe('a hub with ten workers', () => {
  const workers = Array.from({ length: 10 }, (_, i) => `w${i}`)

  it('holds an edge per worker, each with its own budget', () => {
    const book = new PeerLinkBook(1)
    for (const w of workers) book.link('hub', w, 'user', T0)
    expect(book.linksOf('hub')).toHaveLength(10)
    for (const w of workers) expect(book.checkSend('hub', w, T0)).toEqual({ linked: true, ok: true })
    for (const w of workers) expect(book.checkSend(w, 'hub', T0)).toMatchObject({ ok: false })
  })

  it('keeps the banner to one short line and names the spent ones', () => {
    const views: PeerLinkView[] = workers.map((w, i) => ({
      peerThreadId: w, title: `Worker ${i}`, used: i === 3 ? 20 : 1, budget: 20, expiresAt: T0 + PEER_LINK_WINDOW_MS, windowMs: PEER_LINK_WINDOW_MS,
    }))
    expect(peerLinksBannerText(views, T0)).toBe('Linked with 10 sessions · 1 used up')
  })
})

describe('undelivered marker', () => {
  const row = { to: 'w1', toLabel: 'Worker A', reason: 'link-budget' as const, text: 'line 1\n"quoted" → done', sent: false }

  it('round-trips any message body', () => {
    const content = formatUndeliveredMarker(row)
    expect(content.startsWith(PEER_UNDELIVERED_MARKER_PREFIX)).toBe(true)
    expect(parseUndeliveredMarker(content)).toEqual(row)
    expect(parseUndeliveredMarker(formatUndeliveredMarker({ ...row, sent: true }))?.sent).toBe(true)
  })

  it('reads a broken row as no marker', () => {
    expect(parseUndeliveredMarker(`${PEER_UNDELIVERED_MARKER_PREFIX} {not json`)).toBeNull()
    expect(parseUndeliveredMarker(`${PEER_UNDELIVERED_MARKER_PREFIX} {"to":"w1"}`)).toBeNull()
    expect(parseUndeliveredMarker('[[sb:peer-sent]] A → B')).toBeNull()
  })

  it('stores one row per sender, target and text', () => {
    expect(peerUndeliveredId('a', 'b', 'x')).toBe(peerUndeliveredId('a', 'b', 'x'))
    expect(peerUndeliveredId('a', 'b', 'x')).not.toBe(peerUndeliveredId('a', 'b', 'y'))
    expect(peerUndeliveredId('a', 'b', 'x')).toMatch(/^pu_[0-9a-f]{16}$/)
  })

  it('says what happened, and that it went once sent', () => {
    expect(peerUndeliveredHeading(row)).toBe('Not delivered to Worker A: link budget used up')
    expect(peerUndeliveredHeading({ ...row, reason: 'link-expired' })).toBe('Not delivered to Worker A: link time used up')
    expect(peerUndeliveredHeading({ ...row, reason: 'link-removed' })).toBe('Not delivered to Worker A: link removed before it was sent')
    expect(parseUndeliveredMarker(formatUndeliveredMarker({ ...row, reason: 'link-removed' }))?.reason).toBe('link-removed')
    expect(peerUndeliveredHeading({ ...row, sent: true })).toMatch(/^Sent by you/)
  })

  it('names both sessions in the notification', () => {
    expect(peerLinkSpentText('Lead', 'Worker A')).toMatch(/"Lead" and "Worker A"/)
  })
})

const HOUR = 60 * 60_000

describe('link duration', () => {
  it('parses minutes and hours, and nothing without a unit', () => {
    expect(parsePeerLinkDuration('90m')).toBe(90 * 60_000)
    expect(parsePeerLinkDuration('4h')).toBe(4 * HOUR)
    expect(parsePeerLinkDuration('2H')).toBe(2 * HOUR)
    for (const bad of ['30', '1.5h', '4d', 'h', '-1h', '4 hours']) expect(parsePeerLinkDuration(bad), bad).toBeNull()
  })

  it('allows 10 minutes to 24 hours', () => {
    expect(peerLinkWindowProblem(PEER_LINK_MIN_WINDOW_MS)).toBeNull()
    expect(peerLinkWindowProblem(PEER_LINK_MAX_WINDOW_MS)).toBeNull()
    expect(peerLinkWindowProblem(PEER_LINK_MIN_WINDOW_MS - 60_000)).toBe('A link lasts 10 minutes to 24 hours.')
    expect(peerLinkWindowProblem(PEER_LINK_MAX_WINDOW_MS + 60_000)).not.toBeNull()
    expect(new PeerLinkBook().link('a', 'b', 'user', T0, 20, 5 * 60_000)).toMatchObject({ ok: false })
  })

  it('reads the Settings default, falling back to 30 minutes', () => {
    expect(peerLinkDefaultWindow('4h')).toBe(4 * HOUR)
    for (const bad of [null, undefined, '', '5m', '25h', 'soon']) expect(peerLinkDefaultWindow(bad)).toBe(PEER_LINK_WINDOW_MS)
  })

  it('formats a duration and the time left', () => {
    expect(formatPeerLinkDuration(30 * 60_000)).toBe('30 minutes')
    expect(formatPeerLinkDuration(HOUR)).toBe('1 hour')
    expect(formatPeerLinkDuration(4 * HOUR)).toBe('4 hours')
    expect(formatPeerLinkDuration(90 * 60_000)).toBe('1 hour 30 minutes')
    expect(formatPeerLinkTimeLeft(30_000)).toBe('<1m')
    expect(formatPeerLinkTimeLeft(12 * 60_000 + 59_000)).toBe('12m')
    expect(formatPeerLinkTimeLeft(3 * HOUR + 12 * 60_000)).toBe('3h 12m')
  })

  it('expires each edge on its own window, and names it when refusing', () => {
    const book = new PeerLinkBook()
    book.link('hub', 'long', 'user', T0, 20, 4 * HOUR)
    book.link('hub', 'short', 'user', T0)
    expect(book.checkSend('hub', 'short', T0 + PEER_LINK_WINDOW_MS)).toMatchObject({ ok: false, reason: 'link-expired' })
    expect(book.checkSend('hub', 'long', T0 + 4 * HOUR - 1)).toEqual({ linked: true, ok: true })
    const refused = book.checkSend('hub', 'long', T0 + 4 * HOUR)
    expect(refused).toMatchObject({ ok: false, reason: 'link-expired' })
    expect(refused.linked && !refused.ok && refused.message).toMatch(/^This link's time \(4 hours\) is up\./)
  })

  it('restarts the edge\'s own window on Extend', () => {
    const book = new PeerLinkBook()
    book.link('a', 'b', 'user', T0, 20, 2 * HOUR)
    book.extend('a', 'b', 'user', T0 + HOUR)
    expect(book.linksOf('a')[0]).toMatchObject({ expiresAt: T0 + 3 * HOUR, windowMs: 2 * HOUR })
  })

  it('renews with the edge\'s own window on a user turn, in either session', () => {
    for (const human of ['a', 'b']) {
      const book = new PeerLinkBook()
      book.link('a', 'b', 'user', T0, 20, 8 * HOUR)
      book.humanMessage(human, T0 + 7 * HOUR)
      expect(book.linksOf('a')[0]).toMatchObject({ expiresAt: T0 + 15 * HOUR, windowMs: 8 * HOUR })
      book.renew('a', 'b', T0 + 14 * HOUR)
      expect(book.linksOf('a')[0].expiresAt).toBe(T0 + 22 * HOUR)
    }
  })

  it('takes a new window when an existing edge is linked again', () => {
    const book = new PeerLinkBook()
    book.link('a', 'b', 'user', T0, 20, 8 * HOUR)
    book.link('a', 'b', 'user', T0)
    expect(book.linksOf('a')[0].windowMs).toBe(PEER_LINK_WINDOW_MS)
  })
})
