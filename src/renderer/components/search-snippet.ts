/**
 * Render an FTS search snippet to highlighted HTML. Matches are delimited by
 * `**` pairs (SQLite FTS `snippet()` markers). Each pair becomes a balanced
 * <mark>…</mark>, and the raw text is HTML-escaped first so message content
 * can't inject markup via dangerouslySetInnerHTML.
 */
const MARK_OPEN =
  '<mark style="background: var(--accent-subtle); color: var(--accent); border-radius: 2px; padding: 0 2px;">'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderSnippetHtml(snippet: string): string {
  let inMark = false
  const html = escapeHtml(snippet).replace(/\*\*/g, () => {
    inMark = !inMark
    return inMark ? MARK_OPEN : '</mark>'
  })
  // Close a dangling mark if the snippet had an odd number of delimiters.
  return inMark ? html + '</mark>' : html
}
