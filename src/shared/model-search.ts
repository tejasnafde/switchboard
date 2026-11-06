/**
 * Model search for the pickers on every surface. Each word of the query must
 * hit the model's label or id; a prefix scores 3, a word start 2, a substring
 * 1, and from 3 characters a subsequence 0.5. Rows sort by the summed score,
 * ties keep the catalog order. An empty query keeps the catalog as it is.
 */

export interface SearchableModel {
  id: string
  label: string
}

const WORD_START = /[\s/._-]/

/** Scores a lowercased search word against lowercased text. */
export function scoreSearchWord(word: string, text: string): number {
  if (text.startsWith(word)) return 3
  let at = text.indexOf(word)
  const substring = at >= 0
  while (at > 0) {
    if (WORD_START.test(text[at - 1])) return 2
    at = text.indexOf(word, at + 1)
  }
  if (substring) return 1
  if (word.length >= 3 && isSubsequence(word, text)) return 0.5
  return 0
}

function isSubsequence(word: string, text: string): boolean {
  let at = 0
  for (const char of text) {
    if (char === word[at]) at++
    if (at === word.length) return true
  }
  return false
}

/** The model's score for `query`, or 0 when a word of the query misses it. */
export function scoreModel(model: SearchableModel, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const label = model.label.toLowerCase()
  const id = model.id.toLowerCase()
  let total = 0
  for (const word of words) {
    const score = Math.max(scoreSearchWord(word, label), scoreSearchWord(word, id))
    if (score === 0) return 0
    total += score
  }
  return total
}

/** The models that match `query`, best first; all of them in order when it is empty. */
export function searchModels<T extends SearchableModel>(models: readonly T[], query: string): T[] {
  if (!query.trim()) return [...models]
  return models
    .map((model, index) => ({ model, index, score: scoreModel(model, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.model)
}
