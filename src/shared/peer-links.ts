/**
 * Session links: the user lets two sessions on one backend talk to each other.
 *
 * A link is an EDGE between two sessions, and one session can hold many, so a
 * hub thread linked to any number of workers holds one edge per worker, and
 * the workers stay unlinked from each other. Along an edge an agent send skips the hop-depth
 * limit and the per-sender budget (`peer-messaging.ts`), and is bounded by
 * this edge's own exchange budget instead: a number of agent messages and a
 * time window, both picked by the user when linking (the window defaults to
 * the `PEER_LINK_DURATION_SETTING` setting), whichever ends first. A message
 * the user types in either session renews both; Extend adds messages and
 * restarts the window. Each edge keeps its own window length for both.
 *
 * Running out never loses work: the refused message is handed back to the
 * model to report, and stored in the sender's chat (`PEER_UNDELIVERED_MARKER_PREFIX`)
 * for the user to send by hand.
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
import { peerMessageId, type PeerMessageInitiator } from './peer-messaging'

/** Agent messages allowed on one edge by default, both directions together. */
export const PEER_LINK_MESSAGE_BUDGET = 20
/**
 * The most messages one edge may ever hold, whether set by `/link` or reached
 * by Extend. Ten default budgets. The window bounds how long an edge lasts and
 * this bounds how much it says: at the per-pair rate (5 a minute each way) a
 * busy pair can spend 200 in about 20 minutes, so a long window only keeps a
 * sparse exchange alive, and a chatty one still stops for the user.
 */
export const PEER_LINK_MAX_MESSAGES = 200
/** Messages one Extend adds. */
export const PEER_LINK_EXTEND_MESSAGES = 20
/** How long an edge's budget lasts after the link, the last human message or an Extend, unless the user picks otherwise. */
export const PEER_LINK_WINDOW_MS = 30 * 60_000
export const PEER_LINK_MIN_WINDOW_MS = 10 * 60_000
export const PEER_LINK_MAX_WINDOW_MS = 24 * 60 * 60_000
/**
 * Backend setting holding the window a `/link` without a time gets, in the
 * `/link` form (`30m`, `4h`), so every client of the backend reads one value.
 */
export const PEER_LINK_DURATION_SETTING = 'chat.peerLinkDuration'
/** The choices Settings offers for `PEER_LINK_DURATION_SETTING`. */
export const PEER_LINK_DURATION_CHOICES = ['10m', '30m', '1h', '2h', '4h', '8h', '12h', '24h'] as const

/**
 * A link time as `/link` takes it: whole minutes (`90m`) or hours (`4h`).
 * A unit is required, because a bare trailing number is the message budget.
 * Null when the token is not a time at all; range is `peerLinkWindowProblem`'s.
 */
export function parsePeerLinkDuration(token: string): number | null {
  const match = /^(\d+)(m|h)$/i.exec(token.trim())
  if (!match) return null
  return Number(match[1]) * (match[2].toLowerCase() === 'h' ? 60 * 60_000 : 60_000)
}

/** Null when `ms` is a valid link window, else what is wrong with it. */
export function peerLinkWindowProblem(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < PEER_LINK_MIN_WINDOW_MS || ms > PEER_LINK_MAX_WINDOW_MS) {
    return 'A link lasts 10 minutes to 24 hours.'
  }
  return null
}

/** The stored Settings default as a window; anything unreadable or out of range is the 30 minute default. */
export function peerLinkDefaultWindow(stored: string | null | undefined): number {
  const ms = stored ? parsePeerLinkDuration(stored) : null
  return ms !== null && peerLinkWindowProblem(ms) === null ? ms : PEER_LINK_WINDOW_MS
}

/** `30 minutes`, `4 hours`, `1 hour 30 minutes`. */
export function formatPeerLinkDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (h === 0) return unit(m, 'minute')
  return m === 0 ? unit(h, 'hour') : `${unit(h, 'hour')} ${unit(m, 'minute')}`
}

/** Compact time left for the banner: `3h 12m`, `12m`, `<1m`. */
export function formatPeerLinkTimeLeft(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  const h = Math.floor(minutes / 60)
  return h === 0 ? `${minutes}m` : `${h}h ${minutes % 60}m`
}

/** Null when `value` is a valid per-link budget, else what is wrong with it. */
export function peerLinkBudgetProblem(value: number): string | null {
  if (!Number.isInteger(value) || value < 1 || value > PEER_LINK_MAX_MESSAGES) {
    return `A link allows 1 to ${PEER_LINK_MAX_MESSAGES} messages.`
  }
  return null
}

/** One of a session's links, as the banner and the agent tool show it. */
export interface PeerLinkSummary {
  /** Root conversation id of the other session. */
  peerThreadId: string
  used: number
  budget: number
  /** Epoch ms the edge's window closes, unless a human message renews it first. */
  expiresAt: number
  /** This edge's window length, which a renewal or Extend restarts. */
  windowMs: number
}

/** A session's links plus the titles the UI shows. Payload of `LIST_PEER_LINKS`. */
export interface PeerLinkView extends PeerLinkSummary {
  title: string
}

/**
 * Why a linked send was not delivered. `link-removed` is a link the user took
 * away (or a session that went away) while the send was being prepared.
 */
export type PeerLinkRefusal = 'link-budget' | 'link-expired' | 'link-removed'

export type PeerLinkSendCheck =
  | { linked: false }
  | { linked: true; ok: true }
  | {
    linked: true
    ok: false
    reason: PeerLinkRefusal
    message: string
    /** True for the first refusal since the edge ran out, which is the one the user is notified about. */
    firstRefusal: boolean
  }

export type PeerLinkResult =
  | { ok: true; created: boolean }
  | { ok: false; message: string }

interface Edge {
  /** Distinct per link, so an unlink and relink is a different edge, and a different consent. */
  id: number
  since: number
  used: number
  budget: number
  windowMs: number
  /** The user has been told this edge ran out; cleared whenever it is renewed. */
  notified: boolean
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

/**
 * Addressed to the model, which may be running with nobody watching: the
 * message did not arrive, the work must go on, and the undelivered text has to
 * reach the user some other way.
 */
export const PEER_LINK_NOT_DELIVERED =
  'Your message was NOT delivered. Keep working on your own task, and put the undelivered message, ' +
  'or a summary of it, in your final reply to the user so nothing is lost. Switchboard has also kept ' +
  'the message in this chat for the user to send by hand.'

export class PeerLinkBook {
  private readonly edges = new Map<string, Edge>()
  private nextEdgeId = 0

  constructor(
    private readonly defaultBudget = PEER_LINK_MESSAGE_BUDGET,
    private readonly defaultWindowMs = PEER_LINK_WINDOW_MS,
  ) {}

  /**
   * Link two sessions, or renew an existing edge with a new budget and
   * window. Refused for an agent: a link is the user's consent, and a model
   * that could grant it to itself would have no limit at all.
   */
  link(
    a: string,
    b: string,
    initiator: PeerMessageInitiator,
    nowMs: number,
    budget = this.defaultBudget,
    windowMs = this.defaultWindowMs,
  ): PeerLinkResult {
    if (initiator !== 'user') {
      return { ok: false, message: 'Only the user can link sessions.' }
    }
    if (a === b) return { ok: false, message: 'A session cannot be linked with itself.' }
    const problem = peerLinkBudgetProblem(budget) ?? peerLinkWindowProblem(windowMs)
    if (problem) return { ok: false, message: problem }
    const key = edgeKey(a, b)
    const created = !this.edges.has(key)
    const existing = this.edges.get(key)
    this.edges.set(key, { id: existing?.id ?? ++this.nextEdgeId, since: nowMs, used: 0, budget, windowMs, notified: false })
    return { ok: true, created }
  }

  /**
   * Extend: `PEER_LINK_EXTEND_MESSAGES` more messages (up to the maximum) and
   * a fresh run of the edge's own window. User-only, like `link`, for the same reason.
   */
  extend(a: string, b: string, initiator: PeerMessageInitiator, nowMs: number): PeerLinkResult {
    if (initiator !== 'user') return { ok: false, message: 'Only the user can extend a link.' }
    const edge = this.edges.get(edgeKey(a, b))
    if (!edge) return { ok: false, message: 'Those sessions are not linked.' }
    if (edge.budget >= PEER_LINK_MAX_MESSAGES && edge.used >= edge.budget) {
      return {
        ok: false,
        message: `This link is at its ${PEER_LINK_MAX_MESSAGES} message maximum. Type in either chat to start a fresh budget.`,
      }
    }
    edge.budget = Math.min(edge.budget + PEER_LINK_EXTEND_MESSAGES, PEER_LINK_MAX_MESSAGES)
    edge.since = nowMs
    edge.notified = false
    return { ok: true, created: false }
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
      out.push({ peerThreadId: peer, used: edge.used, budget: edge.budget, expiresAt: edge.since + edge.windowMs, windowMs: edge.windowMs })
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
    const refuse = (reason: PeerLinkRefusal, why: string): PeerLinkSendCheck => {
      const firstRefusal = !edge.notified
      edge.notified = true
      return { linked: true, ok: false, reason, firstRefusal, message: `${why} ${PEER_LINK_NOT_DELIVERED}` }
    }
    if (nowMs - edge.since >= edge.windowMs) {
      return refuse('link-expired', `This link's time (${formatPeerLinkDuration(edge.windowMs)}) is up.`)
    }
    if (edge.used >= edge.budget) {
      return refuse('link-budget', `The two sessions have used all ${edge.budget} messages of this link.`)
    }
    edge.used += 1
    return { linked: true, ok: true }
  }

  /** Give back the message a send charged when its delivery then failed. */
  release(from: string, to: string, edgeId?: number): void {
    const edge = this.edges.get(edgeKey(from, to))
    if (!edge || (edgeId !== undefined && edge.id !== edgeId)) return
    if (edge.used > 0) edge.used -= 1
  }

  /**
   * The current edge's id, or null when the pair is not linked. A send checks
   * this again after anything it awaits: the same id means the same link the
   * user made, still in place.
   */
  edgeId(a: string, b: string): number | null {
    return this.edges.get(edgeKey(a, b))?.id ?? null
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
      renewEdge(edge, nowMs)
      peers.push(peer)
    }
    return peers
  }

  /**
   * The user sent along this one edge (`/send-to`, or Send on a message that
   * was not delivered): renew it alone. False when the pair is not linked.
   */
  renew(a: string, b: string, nowMs: number): boolean {
    const edge = this.edges.get(edgeKey(a, b))
    if (!edge) return false
    renewEdge(edge, nowMs)
    return true
  }
}

function renewEdge(edge: Edge, nowMs: number): void {
  edge.since = nowMs
  edge.used = 0
  edge.notified = false
}

/**
 * The banner line for one link: `Worker A · 7 of 20 · 3h 12m left`, or
 * `time up` / `limit reached` once the edge is spent.
 */
export function peerLinkLabel(link: PeerLinkView, nowMs: number): string {
  if (nowMs >= link.expiresAt) return `${link.title} · time up`
  if (link.used >= link.budget) return `${link.title} · limit reached`
  return `${link.title} · ${link.used} of ${link.budget} · ${formatPeerLinkTimeLeft(link.expiresAt - nowMs)} left`
}

/** Above this many links the banner names a count and the popover lists them. */
export const PEER_LINK_BANNER_INLINE_MAX = 2

export function isPeerLinkSpent(link: PeerLinkSummary, nowMs: number): boolean {
  return nowMs >= link.expiresAt || link.used >= link.budget
}

/**
 * The banner's one line: every link inline, or a count once there are several
 * (a hub may hold any number), naming how many are spent so the one that
 * needs Extend is not hidden behind the count.
 */
export function peerLinksBannerText(links: ReadonlyArray<PeerLinkView>, nowMs: number): string {
  if (links.length <= PEER_LINK_BANNER_INLINE_MAX) {
    return `Linked with ${links.map((link) => peerLinkLabel(link, nowMs)).join(', ')}`
  }
  const spent = links.filter((link) => isPeerLinkSpent(link, nowMs)).length
  return `Linked with ${links.length} sessions${spent > 0 ? ` · ${spent} used up` : ''}`
}

/**
 * System row written in the SENDER's chat when a link refused an agent's
 * message, followed by the JSON of a `PeerUndelivered`. JSON rather than the
 * `<from> → <to>` shape of the other markers because it carries the whole
 * message body, which may contain anything.
 */
export const PEER_UNDELIVERED_MARKER_PREFIX = '[[sb:peer-undelivered]]'

export interface PeerUndelivered {
  /** Root id of the session the message was for. */
  to: string
  toLabel: string
  reason: PeerLinkRefusal
  text: string
  /** The user has since sent it by hand. */
  sent: boolean
}

/** One id per (sender, target, text), so a model retrying the same refused send stores it once. */
export function peerUndeliveredId(fromThreadId: string, targetThreadId: string, text: string): string {
  return `pu_${peerMessageId({ fromThreadId, targetThreadId, text }).slice('pm_'.length)}`
}

export function formatUndeliveredMarker(undelivered: PeerUndelivered): string {
  return `${PEER_UNDELIVERED_MARKER_PREFIX} ${JSON.stringify(undelivered)}`
}

export function parseUndeliveredMarker(content: string): PeerUndelivered | null {
  if (!content.startsWith(PEER_UNDELIVERED_MARKER_PREFIX)) return null
  try {
    const raw: unknown = JSON.parse(content.slice(PEER_UNDELIVERED_MARKER_PREFIX.length))
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (typeof r.to !== 'string' || typeof r.toLabel !== 'string' || typeof r.text !== 'string') return null
    if (r.reason !== 'link-budget' && r.reason !== 'link-expired' && r.reason !== 'link-removed') return null
    return { to: r.to, toLabel: r.toLabel, reason: r.reason, text: r.text, sent: r.sent === true }
  } catch {
    // A hand-edited or truncated row: show it as an ordinary system message.
    return null
  }
}

/** The notification text for a link that ran out, naming both sessions. */
export function peerLinkSpentText(fromLabel: string, toLabel: string): string {
  return `The link between "${fromLabel}" and "${toLabel}" is used up. A message was not delivered; it is kept in "${fromLabel}" for you to send.`
}

/** The row's heading. */
export function peerUndeliveredHeading(undelivered: PeerUndelivered): string {
  if (undelivered.sent) return `Sent by you to ${undelivered.toLabel} after the link ran out`
  const why = undelivered.reason === 'link-expired'
    ? 'link time used up'
    : undelivered.reason === 'link-removed' ? 'link removed before it was sent' : 'link budget used up'
  return `Not delivered to ${undelivered.toLabel}: ${why}`
}
