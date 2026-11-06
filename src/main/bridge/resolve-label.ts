/**
 * Resolving a label the caller typed (a project or chat name from an earlier
 * answer) to one item. Exact ids are the caller's job and win before this.
 */
import { foldForSearch, isWordPrefixMatch, messageSearchTerms } from '@shared/message-search'

/** At most this many choices go back with `ambiguous_target`. */
const LABEL_CHOICE_LIMIT = 5

function normalizeLabel(text: string): string {
  return foldForSearch(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ')
}

export type LabelResolution<T> = { kind: 'one'; item: T } | { kind: 'ambiguous'; choices: T[] } | { kind: 'none' }

/**
 * The exact normalized label first; then every typed word as a word prefix of
 * the label. Two or more plausible items are ambiguous: none is picked.
 */
export function resolveLabel<T>(items: readonly T[], labelOf: (item: T) => string, query: string): LabelResolution<T> {
  const wanted = normalizeLabel(query)
  if (!wanted) return { kind: 'none' }
  const pick = (found: T[]): LabelResolution<T> | null =>
    found.length === 1
      ? { kind: 'one', item: found[0] }
      : found.length > 1
        ? { kind: 'ambiguous', choices: found.slice(0, LABEL_CHOICE_LIMIT) }
        : null
  const exact = pick(items.filter((item) => normalizeLabel(labelOf(item)) === wanted))
  if (exact) return exact
  const terms = messageSearchTerms(query)
  return pick(items.filter((item) => isWordPrefixMatch(labelOf(item), terms))) ?? { kind: 'none' }
}
