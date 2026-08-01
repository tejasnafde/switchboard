/**
 * Signed-in account presentation helpers. Pure, so they are testable without
 * the auth module or a device keychain.
 */

/**
 * Two-letter monogram from an email's local part - "tejas.nafde@x.io" gives TN.
 * An unusable value gives a dash rather than wrong initials.
 */
export function initialsFromEmail(email: string | null | undefined): string {
  const local = (email ?? '').split('@')[0]
  const words = local.split(/[._\-+]+/).filter((w) => /[a-z0-9]/i.test(w))
  if (words.length === 0) return '-'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}
