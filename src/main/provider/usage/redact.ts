/**
 * Scrub credential shapes out of strings we did not author - child stderr and
 * thrown error messages - before they reach a user-facing message or a log.
 * Neither is known to echo a token today, but both render in Settings.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+\S+/gi, 'Bearer [redacted]'],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted-token]'],
  [/sk-[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/eyJ[A-Za-z0-9_-]{16,}/g, '[redacted-jwt]'],
]

export function redactSecrets(value: string): string {
  let out = value
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}
