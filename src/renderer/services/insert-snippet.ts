/**
 * Insert `snippet` into `body` at [start, end), wrapping with leading and
 * trailing newlines only when needed so the snippet doesn't fuse to
 * surrounding prose.
 *
 * Used by CardModal's image-paste handler: an embedded `![](...)` markdown
 * line should always end up on its own line, regardless of where the user's
 * caret happens to land.
 */
export function insertSnippetWithNewlineGuards(
  body: string,
  start: number,
  end: number,
  snippet: string,
): string {
  const s = Math.max(0, Math.min(body.length, start))
  const e = Math.max(s, Math.min(body.length, end))
  const lead = s > 0 && body[s - 1] !== '\n' ? '\n' : ''
  const trail = e < body.length && body[e] !== '\n' ? '\n' : ''
  return body.slice(0, s) + lead + snippet + trail + body.slice(e)
}
