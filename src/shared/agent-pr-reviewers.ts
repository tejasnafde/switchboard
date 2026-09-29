/**
 * The reviewers an AGENT names for a pull request it asks Switchboard to open
 * (`reviewers` on `create_pull_request`): the names as the agent sent them,
 * and how each one is matched against the repository's reviewer candidates.
 * A name matches only exactly (case aside) on a candidate's id, login,
 * display name or an email the host listed; anything else is refused with the
 * close candidates, never guessed. Pure, so the tool, the service and the tests share it.
 */
import type { PrHost, PrReviewerCandidate } from './pull-requests'
import type { Checked } from './agent-pr-create'

/** The most reviewers one agent pull request may ask for. */
export const AGENT_PR_MAX_REVIEWERS = 10
const NAME_MAX_CHARS = 200
/** Close candidates listed for a name that matched none or several. */
const CLOSE_MAX = 5

/** A reviewer as the card shows it and the approval sends it. */
export interface HostWriteReviewer {
  /** `PrReviewerCandidate.id`: a GitHub login or `team:<slug>`, a Bitbucket account uuid. */
  id: string
  /** What an agent could type to name them: the GitHub login or `team:<slug>`, the Bitbucket nickname. */
  login: string
  displayName: string
  kind: 'user' | 'team'
}

/** The signed-in user, who opens the pull request and so cannot review it. */
export interface ReviewerViewer {
  /** A GitHub login, a Bitbucket account uuid. */
  id: string | null
  login: string | null
}

/** "Jane Doe (jdoe)", or just the login when the host gave no other name. */
export function reviewerLabel(r: Pick<HostWriteReviewer, 'login' | 'displayName'>): string {
  return r.displayName === r.login ? r.login : `${r.displayName} (${r.login})`
}

/** The agent's `reviewers`: absent is none; case-insensitive duplicates are dropped. */
export function checkReviewerNames(value: unknown): Checked<string[]> {
  if (value === undefined || value === null) return { ok: true, value: [] }
  if (!Array.isArray(value)) return { ok: false, message: '"reviewers" is a list of names, logins or emails.' }
  const names: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return { ok: false, message: 'Every entry of "reviewers" is a non-empty name, login or email.' }
    const name = item.trim()
    if (name.length > NAME_MAX_CHARS || name.includes('\u0000')) return { ok: false, message: `The reviewer "${name.slice(0, 40)}" is not a name.` }
    const key = normalize(name)
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  if (names.length > AGENT_PR_MAX_REVIEWERS) {
    return { ok: false, message: `That is ${names.length} reviewers; a pull request opened here asks for at most ${AGENT_PR_MAX_REVIEWERS}.` }
  }
  return { ok: true, value: names }
}

function normalize(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase()
}

/** What a name may equal: the id, the login, the display name, an email the host listed, and for a team its bare slug. */
function keysOf(c: PrReviewerCandidate): string[] {
  const keys = [c.id, c.person.login, c.person.displayName, c.email ?? '']
  if (c.kind === 'team' && c.id.startsWith('team:')) keys.push(c.id.slice('team:'.length))
  return keys.filter(Boolean).map(normalize)
}

function toReviewer(c: PrReviewerCandidate): HostWriteReviewer {
  return { id: c.id, login: c.kind === 'team' && c.id.startsWith('team:') ? c.id : c.person.login, displayName: c.person.displayName, kind: c.kind }
}

function words(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
}

/** Candidates a name is near: one contains the other, or they share a word. An email is compared by its local part. */
function closeTo(name: string, candidates: readonly PrReviewerCandidate[]): PrReviewerCandidate[] {
  const raw = normalize(name)
  const q = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw
  const qWords = words(q)
  return candidates.filter((c) => keysOf(c).some((k) =>
    (q.length >= 2 && k.includes(q)) || (k.length >= 3 && q.includes(k)) || words(k).some((w) => qWords.includes(w)),
  )).slice(0, CLOSE_MAX)
}

function isViewer(host: PrHost, c: PrReviewerCandidate, viewer: ReviewerViewer | null): boolean {
  if (!viewer) return false
  const same = (a: string | null, b: string) => !!a && (host === 'github' ? a.toLowerCase() === b.toLowerCase() : a === b)
  return same(viewer.id, c.id) || (c.kind === 'user' && same(viewer.login, c.person.login))
}

/**
 * Every name matched to exactly one candidate, or why not, naming each name
 * that failed. The author (the signed-in user) is refused, never dropped
 * silently, so the agent learns why they are missing.
 */
export function resolveReviewers(
  host: PrHost,
  names: readonly string[],
  candidates: readonly PrReviewerCandidate[],
  viewer: ReviewerViewer | null,
): Checked<HostWriteReviewer[]> {
  const out: HostWriteReviewer[] = []
  const problems: string[] = []
  const suggest = (list: readonly PrReviewerCandidate[]) => list.map((c) => reviewerLabel(toReviewer(c))).join(', ')
  for (const name of names) {
    const key = normalize(name)
    const hits = candidates.filter((c) => keysOf(c).includes(key))
    const ids = new Set(hits.map((c) => c.id))
    if (ids.size === 0) {
      const close = closeTo(name, candidates)
      problems.push(`"${name}" is not someone who can review here${close.length > 0 ? `; close: ${suggest(close)}` : ''}.`)
    } else if (ids.size > 1) {
      problems.push(`"${name}" matches ${ids.size} people: ${suggest(hits)}. Use a login.`)
    } else if (isViewer(host, hits[0], viewer)) {
      problems.push(`"${name}" is the signed-in user, who opens the pull request and so cannot review it.`)
    } else if (!out.some((r) => r.id === hits[0].id)) {
      out.push(toReviewer(hits[0]))
    }
  }
  if (problems.length > 0) {
    return { ok: false, message: `${problems.join(' ')} Call again with logins exactly as listed, or without those reviewers. Nothing was created.` }
  }
  return { ok: true, value: out }
}

/** The reviewers the card kept: the approval's ids, in the card's order. Absent means all of them (a phone, a plain client). */
export function keptReviewers(card: readonly HostWriteReviewer[], kept: readonly string[] | undefined): HostWriteReviewer[] {
  if (kept === undefined) return [...card]
  const ids = new Set(kept)
  return card.filter((r) => ids.has(r.id))
}
