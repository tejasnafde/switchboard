import { fuzzyScore } from '../files/fuzzyScore'

/**
 * `@`-mention file autocomplete trigger detection.
 *
 * Mirrors `detectSlashTrigger` in spirit but tuned for file paths:
 *   - Trigger fires when the most recent `@` before the cursor is preceded
 *     by start-of-text or whitespace.
 *   - The query may contain `/`, `.`, `-`, `_` and other path-shaped chars
 *     — only whitespace closes the trigger window. (Slash mode bails on
 *     `/` because slash commands are flat names; here `/` is part of the
 *     query so the user can narrow on directory prefixes.)
 *
 * Examples:
 *   "@src"                → fires, query = "src"
 *   "hi @src/main"        → fires, query = "src/main"
 *   "see @"               → fires, query = ""
 *   "foo@bar"             → does NOT fire (no leading whitespace before @)
 *   "user@example.com"    → does NOT fire (same reason)
 *   "@src/main\nmore"     → does NOT fire if cursor is past the newline
 *
 * Pure — exported for unit tests.
 */
export interface AtTrigger {
  query: string
  rangeStart: number
  rangeEnd: number
}

export function detectAtTrigger(text: string, cursorInput: number): AtTrigger | null {
  const cursor = Math.max(0, Math.min(cursorInput, text.length))
  if (cursor === 0) return null

  let atIdx = -1
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') { atIdx = i; break }
    if (/\s/.test(ch)) return null
  }
  if (atIdx === -1) return null

  if (atIdx > 0 && !/\s/.test(text[atIdx - 1])) return null

  return {
    query: text.slice(atIdx + 1, cursor),
    rangeStart: atIdx,
    rangeEnd: cursor,
  }
}

/**
 * Score + sort `files` against `query` using the shared fuzzyScore.
 * Returns up to 50 matches in descending score order. Pure — exported so
 * both the AtMentionMenu and the keyboard-commit path in ChatInput agree
 * on which file the highlighted index refers to.
 */
export function filterAtMatches(query: string, files: string[]): string[] {
  if (!query) return files.slice(0, 50)
  const scored: { path: string; score: number }[] = []
  for (const f of files) {
    const s = fuzzyScore(query, f)
    if (s !== null) scored.push({ path: f, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 50).map((s) => s.path)
}
