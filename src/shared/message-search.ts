/**
 * Message search (cmd+shift+F, the phone's search screen): the query rule, the
 * result shape on the `app:search-messages` channel and the order results are
 * shown in. Pure, so the backend and the renderer (which merges results from
 * several machines) order them the same way.
 */

export interface MessageSearchResult {
  messageId: string
  conversationId: string
  role: string
  content: string
  /** FTS snippet, matches wrapped in `**` (kept for older clients). */
  snippet: string
  conversationTitle: string
  projectPath: string
  agentType: string
  worktreePath: string | null
  worktreeBranch: string | null
  // Added with the word-prefix search. A backend from before it omits them,
  // so readers treat them as optional.
  /** The same snippet with matches wrapped in SNIPPET_MARK_OPEN / _CLOSE. */
  snippetMarked?: string
  /** SQLite bm25: negative, lower is more relevant. */
  rank?: number
  /** Message time, epoch ms. */
  timestamp?: number
  /** The words occur together, in order, as typed. */
  phraseMatch?: boolean
  archived?: boolean
}

// Control characters cannot occur in typed text and, unlike `**`, are not
// markdown, so a bold word in a message is never mistaken for a match.
export const SNIPPET_MARK_OPEN = '\u0002'
export const SNIPPET_MARK_CLOSE = '\u0003'

export const MESSAGE_SEARCH_LIMIT = 50

/** FTS5 operators. Quoted they are plain words, but typed bare they mean the operator. */
const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR'])

/**
 * The words of a query, the way the unicode61 tokenizer splits text: runs of
 * letters and digits. Punctuation, quotes, parentheses and FTS syntax
 * (`*`, `:`, `^`, `-`) separate words, so no query can be a syntax error.
 */
export function messageSearchTerms(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !FTS_OPERATORS.has(word))
}

/**
 * The FTS5 MATCH expression: every word must match, each as a word prefix
 * ("sync" finds "syncing"). Each word is quoted, which also keeps it from
 * being read as a column name or an operator.
 */
export function ftsMatchExpression(terms: readonly string[]): string | null {
  if (terms.length === 0) return null
  return terms.map((term) => `"${term}"*`).join(' ')
}

/** The words as one FTS5 phrase, the last a prefix; null for a single word. */
export function ftsPhraseExpression(terms: readonly string[]): string | null {
  if (terms.length < 2) return null
  return `"${terms.join(' ')}"*`
}

/** The words of text, lower-cased, split the way the unicode61 tokenizer splits it. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function normalizedWords(text: string): string {
  return ` ${wordsOf(text).join(' ')}`
}

/**
 * True when the words occur next to each other in the typed order, the last
 * one as a prefix. One word is always a phrase.
 */
export function isPhraseMatch(text: string, terms: readonly string[]): boolean {
  if (terms.length < 2) return true
  return normalizedWords(text).includes(` ${terms.join(' ').toLowerCase()}`)
}

/**
 * True when every term is a prefix of some word in text, the same rule
 * FTS5's `"term"*` match expression applies. The fallback scan (`message-search.ts`
 * in main, used only when the FTS index itself fails) reads candidates with a
 * looser SQL `LIKE`, which also matches a term occurring inside a word (`cat`
 * in `concatenate`); this filters those back out so the fallback only keeps
 * what FTS itself would have matched.
 */
export function isWordPrefixMatch(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false
  const words = wordsOf(text)
  return terms.every((term) => {
    const lowerTerm = term.toLowerCase()
    return words.some((word) => word.startsWith(lowerTerm))
  })
}

type Rankable = Pick<MessageSearchResult, 'rank' | 'timestamp' | 'phraseMatch'>

/** Scores within the same tenth of the best score count as a tie. */
const RELEVANCE_BUCKETS = 10

function relevanceBucket(rank: number | undefined, best: number): number {
  if (rank === undefined || !Number.isFinite(rank) || best >= 0) return 0
  return Math.ceil(Math.min(1, rank / best) * RELEVANCE_BUCKETS)
}

/**
 * Display order: a phrase match first, then relevance (bm25), and among
 * results of about the same relevance the newer message first. Results from
 * an older backend carry no rank and keep their relative order at the end.
 */
export function orderMessageSearchResults<T extends Rankable>(results: readonly T[]): T[] {
  const best = Math.min(0, ...results.map((r) => r.rank ?? 0))
  const keyed = results.map((result, index) => ({
    result,
    index,
    phrase: result.phraseMatch ? 1 : 0,
    bucket: relevanceBucket(result.rank, best),
  }))
  keyed.sort((a, b) =>
    b.phrase - a.phrase
    || b.bucket - a.bucket
    || (b.result.timestamp ?? 0) - (a.result.timestamp ?? 0)
    || (a.result.rank ?? 0) - (b.result.rank ?? 0)
    || a.index - b.index)
  return keyed.map((k) => k.result)
}

/**
 * The in-chat find rule (cmd+F): the text holds the query as typed, or every
 * word of it anywhere (a substring, looser than the FTS word prefix), so a
 * message the global search found is a match here too.
 */
export function textMatchesSearch(text: string, query: string): boolean {
  const raw = query.trim()
  if (!raw) return false
  const q = raw.toLowerCase()
  const lower = text.toLowerCase()
  if (lower.includes(q)) return true
  // Terms come from the trimmed ORIGINAL query, the same input the FTS match
  // expression is built from (searchMessagesInDatabase), so the two agree on
  // which words are bare FTS operators (AND/OR/NOT/NEAR) and drop them alike.
  // Lowercasing first would hide the uppercase operator words from
  // messageSearchTerms's filter and leave them in as ordinary terms.
  const terms = messageSearchTerms(raw).map((term) => term.toLowerCase())
  return terms.length > 0 && terms.every((term) => lower.includes(term))
}
