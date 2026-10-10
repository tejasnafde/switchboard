import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN, type MessageSearchResult } from '@shared/message-search'

/**
 * Render an FTS search snippet to highlighted HTML. The raw text is
 * HTML-escaped first so message content can't inject markup via
 * dangerouslySetInnerHTML, and every mark is balanced.
 *
 * A current backend sends `snippetMarked`, delimited by control characters
 * that typed text never holds. An older one sends only `snippet`, delimited by
 * `**` pairs, which a bold word in the message also produces.
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

function renderMarkedSnippetHtml(snippet: string): string {
  let inMark = false
  const html = escapeHtml(snippet).replace(new RegExp(`[${SNIPPET_MARK_OPEN}${SNIPPET_MARK_CLOSE}]`, 'g'), (marker) => {
    const open = marker === SNIPPET_MARK_OPEN
    if (open === inMark) return ''
    inMark = open
    return open ? MARK_OPEN : '</mark>'
  })
  return inMark ? html + '</mark>' : html
}

export function renderSearchResultSnippetHtml(result: Pick<MessageSearchResult, 'snippet' | 'snippetMarked'>): string {
  return result.snippetMarked !== undefined
    ? renderMarkedSnippetHtml(result.snippetMarked)
    : renderSnippetHtml(result.snippet)
}
