/**
 * Generate a conversation title from the first user message.
 * Truncates at word boundary, strips markdown/code artifacts.
 */
export function generateTitle(firstMessage: string, maxLength = 50): string {
  // Strip code blocks and inline code
  let cleaned = firstMessage
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return 'New conversation'

  // Truncate at word boundary
  if (cleaned.length <= maxLength) return cleaned

  const truncated = cleaned.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(' ')
  if (lastSpace > maxLength * 0.5) {
    return truncated.slice(0, lastSpace) + '\u2026'
  }
  return truncated + '\u2026'
}
