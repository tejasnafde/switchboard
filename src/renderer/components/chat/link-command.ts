/**
 * `/link <session>` and `/unlink [session]` - parsing only. Target resolution
 * is `/send-to`'s (`resolveSendToTarget`), so a typo or an ambiguous name
 * fails the same way in all three commands.
 */

export const LINK_USAGE = 'Use /link <session> to let this chat and another one message each other.'

export type LinkCommand =
  | { ok: true; kind: 'link'; target: string }
  /** No target means every link of this chat. */
  | { ok: true; kind: 'unlink'; target: string | null }
  | { ok: false; error: string }

/** Null when the body is not a `/link` or `/unlink` command at all. */
export function parseLinkCommand(body: string): LinkCommand | null {
  const match = /^\/(link|unlink)\b\s*(.*)$/s.exec(body.trim())
  if (!match) return null
  const target = match[2].trim()
  if (match[1] === 'unlink') return { ok: true, kind: 'unlink', target: target || null }
  if (!target) return { ok: false, error: `Name a session. ${LINK_USAGE}` }
  return { ok: true, kind: 'link', target }
}
