/**
 * Two-character badge shown in the instance rail, picker chips, and
 * settings card. Picks first letters of the first two whitespace/hyphen/
 * underscore-separated words; falls back to the first two characters of
 * a single-word name. Returns "??" for empty input so the badge is never
 * blank.
 *
 * Lifted from t3code's `providerInstanceInitials` helper to keep parity
 * with the picker UI we ported.
 */
export function providerInstanceInitials(name: string): string {
  const cleaned = name.trim()
  if (!cleaned) return '??'
  const parts = cleaned.split(/[\s\-_]+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return cleaned.slice(0, 2).toUpperCase()
}
