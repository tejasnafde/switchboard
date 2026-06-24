/**
 * Pure helpers for the `git grep` symbol-definition fallback. Kept out of
 * `ipc/files.ts` (which imports electron) so they unit-test in plain Node.
 */
export const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** ERE matching a declaration of `symbol` (symbol is validated, no injection). */
export function declarationPattern(symbol: string): string {
  return `(function|const|let|var|class|type|interface|enum|def|fn|func|struct)[[:space:]]+${symbol}([^A-Za-z0-9_$]|$)`
}

/** Parse `git grep -n` output (`path:line:text`) into definition hits. */
export function parseGitGrep(
  stdout: string,
  symbol: string,
  cap = 20,
): Array<{ relPath: string; line: number; ch: number }> {
  const out: Array<{ relPath: string; line: number; ch: number }> = []
  for (const raw of stdout.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(raw)
    if (!m) continue
    const idx = m[3].indexOf(symbol)
    out.push({ relPath: m[1], line: Number(m[2]), ch: idx >= 0 ? idx : 0 })
    if (out.length >= cap) break
  }
  return out
}
