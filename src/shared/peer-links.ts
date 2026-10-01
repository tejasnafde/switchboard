/**
 * Session links: the user lets two sessions on one backend talk to each other.
 *
 * A link is an EDGE between two sessions, and one session can hold many, so a
 * hub thread linked to three workers is three edges and the workers stay
 * unlinked from each other. Along an edge an agent send skips the hop-depth
 * limit and the per-sender budget (`peer-messaging.ts`), and is bounded by
 * this edge's own exchange budget instead: a fixed number of agent messages or
 * a time window, whichever ends first, both renewed by a human message in
 * either session.
 *
 * Only the user links. `link` refuses an agent initiator, and no tool reaches
 * it; the IPC handler forces `'user'` the same way `/send-to` does.
 *
 * Ids are ROOT conversation ids (`resolveRootThreadId`): a Claude session id
 * rotates after its first turn, and an edge keyed by the rotated id would
 * silently stop matching.
 *
 * Pure and in memory, with `now` injected. Links do not survive a backend
 * restart: every session is stopped by then, and stopping a session removes
 * its links anyway, so a persisted link would only ever be a stale one.
 */
import type { PeerMessageInitiator } from './peer-messaging'

/** Agent messages allowed on one edge, both directions together. */
export const PEER_LINK_MESSAGE_BUDGET = 20
/** How long an edge's budget lasts after the link or the last human message. */
export const PEER_LINK_WINDOW_MS = 30 * 60_000

/** One of a session's links, as the banner and the agent tool show it. */
export interface PeerLinkSummary {
  /** Root conversation id of the other session. */
  peerThreadId: string
  used: number
  budget: number
  /** Epoch ms the edge's window closes, unless a human message renews it first. */
  expiresAt: number
}

/** A session's links plus the titles the UI shows. Payload of `LIST_PEER_LINKS`. */
export interface PeerLinkView extends PeerLinkSummary {
  title: string
}

export type PeerLinkRefusal = 'link-budget' | 'link-expired'

export type PeerLinkSendCheck =
  | { linked: false }
  | { linked: true; ok: true }
  | { linked: true; ok: false; reason: PeerLinkRefusal; message: string }

export type PeerLinkResult =
  | { ok: true; created: boolean }
  | { ok: false; message: string }

interface Edge {
  since: number
  used: number
}

/** Order-independent key, NUL-separated like `peerMessageId`. */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

function otherEnd(key: string, id: string): string | null {
  const [a, b] = key.split('\u0000')
  if (a === id) return b
  if (b === id) return a
  return null
}

const RELINK_HINT = 'The user can relink the two sessions, or type in either chat, to renew it.'

export class PeerLinkBook {
  private readonly edges = new Map<string, Edge>()

  constructor(
    private readonly budget = PEER_LINK_MESSAGE_BUDGET,
    private readonly windowMs = PEER_LINK_WINDOW_MS,
  ) {}

  /**
   * Link two sessions, or renew an existing edge's budget. Refused for an
   * agent: a link is the user's consent, and a model that could grant it to
   * itself would have no limit at all.
   */
  link(a: string, b: string, initiator: PeerMessageInitiator, nowMs: number): PeerLinkResult {
    if (initiator !== 'user') {
      return { ok: false, message: 'Only the user can link sessions.' }
    }
    if (a === b) return { ok: false, message: 'A session cannot be linked with itself.' }
    const key = edgeKey(a, b)
    const created = !this.edges.has(key)
    this.edges.set(key, { since: nowMs, used: 0 })
    return { ok: true, created }
  }

  /** Remove one edge, or every edge of `a` when `b` is omitted. Returns the peers unlinked. */
  unlink(a: string, b?: string): string[] {
    if (b !== undefined) return this.edges.delete(edgeKey(a, b)) ? [b] : []
    return this.removeSession(a)
  }

  /** Drop every edge touching a session (stopped, archived). Returns the peers unlinked. */
  removeSession(id: string): string[] {
    const peers: string[] = []
    for (const key of [...this.edges.keys()]) {
      const peer = otherEnd(key, id)
      if (peer === null) continue
      this.edges.delete(key)
      peers.push(peer)
    }
    return peers
  }

  isLinked(a: string, b: string): boolean {
    return this.edges.has(edgeKey(a, b))
  }

  linksOf(id: string): PeerLinkSummary[] {
    const out: PeerLinkSummary[] = []
    for (const [key, edge] of this.edges) {
      const peer = otherEnd(key, id)
      if (peer === null) continue
      out.push({ peerThreadId: peer, used: edge.used, budget: this.budget, expiresAt: edge.since + this.windowMs })
    }
    return out
  }

  /**
   * Whether an AGENT send from `from` to `to` rides a link, and if so whether
   * the edge has budget left, charging one message when it does. `linked:
   * false` means the ordinary agent limits apply, untouched by this book.
   *
   * The window is checked before the count, so an expired edge reports the
   * reason the user can act on soonest.
   */
  checkSend(from: string, to: string, nowMs: number): PeerLinkSendCheck {
    const edge = this.edges.get(edgeKey(from, to))
    if (!edge) return { linked: false }
    if (nowMs - edge.since >= this.windowMs) {
      return {
        linked: true,
        ok: false,
        reason: 'link-expired',
        message:
          `This link's ${Math.round(this.windowMs / 60_000)} minutes are up, so nothing more is sent along it. ` +
          `Stop the exchange here and summarise where it got to for the user. ${RELINK_HINT}`,
      }
    }
    if (edge.used >= this.budget) {
      return {
        linked: true,
        ok: false,
        reason: 'link-budget',
        message:
          `The two sessions have exchanged ${this.budget} messages on this link, which is its limit. ` +
          `Stop the exchange here and summarise where it got to for the user. ${RELINK_HINT}`,
      }
    }
    edge.used += 1
    return { linked: true, ok: true }
  }

  /** Give back the message a send charged when its delivery then failed. */
  release(from: string, to: string): void {
    const edge = this.edges.get(edgeKey(from, to))
    if (edge && edge.used > 0) edge.used -= 1
  }

  /**
   * The user typed in `id`: renew every edge it is on. Returns the peers whose
   * edge was renewed, so the caller knows whom to tell.
   */
  humanMessage(id: string, nowMs: number): string[] {
    const peers: string[] = []
    for (const [key, edge] of this.edges) {
      const peer = otherEnd(key, id)
      if (peer === null) continue
      edge.since = nowMs
      edge.used = 0
      peers.push(peer)
    }
    return peers
  }
}

/**
 * The banner line for one link: `Worker A (7 of 20)`, or `(time up)` /
 * `(limit reached)` once the edge is spent.
 */
export function peerLinkLabel(link: PeerLinkView, nowMs: number): string {
  if (nowMs >= link.expiresAt) return `${link.title} (time up)`
  if (link.used >= link.budget) return `${link.title} (limit reached)`
  return `${link.title} (${link.used} of ${link.budget})`
}

/** Above this many links the banner names a count and the popover lists them. */
export const PEER_LINK_BANNER_INLINE_MAX = 2

/** The banner's one line: every link inline, or a count once there are several. */
export function peerLinksBannerText(links: ReadonlyArray<PeerLinkView>, nowMs: number): string {
  if (links.length <= PEER_LINK_BANNER_INLINE_MAX) {
    return `Linked with ${links.map((link) => peerLinkLabel(link, nowMs)).join(', ')}`
  }
  return `Linked with ${links.length} sessions`
}
