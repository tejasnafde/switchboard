/**
 * Signed-in account presentation helpers. Pure, so they are testable without
 * the auth module or a device keychain.
 */

/**
 * Two-letter monogram for an account avatar.
 *
 * Prefers the dotted/underscored name part of an email, which is how most work
 * addresses encode a person - "tejas.nafde@x.io" gives TN. A single-word local
 * part falls back to its first two letters, and an unusable value gives a
 * neutral dash rather than a wrong set of initials.
 */
export function initialsFromEmail(email: string | null | undefined): string {
  const local = (email ?? '').split('@')[0]
  const words = local.split(/[._\-+]+/).filter((w) => /[a-z0-9]/i.test(w))
  if (words.length === 0) return '-'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}
