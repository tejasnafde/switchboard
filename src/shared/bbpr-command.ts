/**
 * The bbpr CLI takes a Bitbucket pull request by number (`bbpr 605`,
 * `bbpr 605 diff`) and finds the repository from the current git remote, so a
 * review chat's tool input often names a PR by number alone. Only a command
 * that invokes bbpr counts: at the start of the command or after `&&`, `||`,
 * `;`, `|` or a newline, outside quotes (so `cd <dir> && bbpr 605` does too).
 */

const BBPR_AT_START = /^(?:[^\s'"]*\/)?bbpr\s+(\d{1,9})(?=\s|$)/

/** Top-level commands of a shell line, split on `&&`, `||`, `;`, `|` and newlines outside quotes. */
function shellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') { current += ch + (command[i + 1] ?? ''); i++; continue }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      segments.push(current)
      current = ''
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

/** PR numbers a shell command hands to bbpr as its first argument, in order, without repeats. */
export function bbprPullRequestNumbers(command: string): number[] {
  if (!command.includes('bbpr')) return []
  const numbers: number[] = []
  for (const segment of shellSegments(command)) {
    const match = BBPR_AT_START.exec(segment)
    const number = match ? Number(match[1]) : 0
    if (number > 0 && !numbers.includes(number)) numbers.push(number)
  }
  return numbers
}

/**
 * The shell command in a tool call's input: Claude's Bash `{ command: "..." }`,
 * Codex's `{ command: ["bash", "-lc", "..."] }`, or a bare command string.
 */
export function toolInputCommand(input: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    // Not JSON: the input is the command itself.
    return input
  }
  if (typeof parsed === 'string') return parsed
  if (!parsed || typeof parsed !== 'object') return null
  const command = (parsed as { command?: unknown; cmd?: unknown }).command ?? (parsed as { cmd?: unknown }).cmd
  if (typeof command === 'string') return command
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
    const parts = command as string[]
    const shellFlag = parts.findIndex((part) => part === '-c' || part === '-lc')
    return shellFlag >= 0 && shellFlag === parts.length - 2 ? parts[parts.length - 1] : parts.join(' ')
  }
  return null
}

/** The working directory a tool input names for its command (Codex records `cwd`), when absolute. */
export function toolInputCwd(input: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    // Not JSON: a bare command names no directory.
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { cwd, workdir } = parsed as { cwd?: unknown; workdir?: unknown }
  const dir = typeof cwd === 'string' ? cwd : typeof workdir === 'string' ? workdir : null
  return dir !== null && dir.startsWith('/') ? dir : null
}

/**
 * `bbprTargets` for a tool input that may record its own directory: a bare
 * number there runs in THAT directory, so its repository gets checked instead
 * of being taken for the chat's.
 */
export function bbprTargetsForInput(command: string, chatCwd: string | null, recordedCwd: string | null): BbprTarget[] {
  if (recordedCwd === null) return bbprTargets(command, chatCwd)
  return bbprTargets(command, recordedCwd).map((t) => (t.runsIn === 'cwd' ? { number: t.number, runsIn: 'dir' as const, dir: recordedCwd } : t))
}

/**
 * Where a bare `bbpr <n>` runs, which decides whose PR the number is:
 * `cwd` (no `cd` before it, so the tool's own working directory), `dir` (the
 * directory the `cd`s before it lead to, resolved against `cwd`), or
 * `unknown` (a `cd` that cannot be resolved without a shell: `~`, a variable,
 * `cd -`, a bare `cd`, `popd`, or a relative path with no known `cwd`).
 */
export type BbprTarget =
  | { number: number; runsIn: 'cwd' }
  | { number: number; runsIn: 'dir'; dir: string }
  | { number: number; runsIn: 'unknown' }

const CD = /^(?:cd|pushd)(?:\s+(.*))?$/

/** One `cd` argument, unquoted, or null when only a shell could resolve it. */
function cdArgument(raw: string | undefined): string | null {
  const arg = (raw ?? '').trim()
  const quoted = /^(["'])(.*)\1$/.exec(arg)
  const path = quoted ? quoted[2] : arg
  if (!quoted && /\s/.test(path)) return null
  if (!path || path.startsWith('-') || /[$`~*?]/.test(path)) return null
  return path
}

/** A POSIX path join and normalise, without node's path module (shared runs in the phone too). */
function resolvePosix(base: string, path: string): string {
  const parts: string[] = []
  for (const part of `${path.startsWith('/') ? '' : `${base}/`}${path}`.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Every bare `bbpr <n>` in a shell command, with the directory it runs in. */
export function bbprTargets(command: string, cwd: string | null): BbprTarget[] {
  if (!command.includes('bbpr')) return []
  const out: BbprTarget[] = []
  // null: no cd yet; undefined: a cd we could not follow.
  let dir: string | null | undefined = null
  for (const segment of shellSegments(command)) {
    const cd = CD.exec(segment)
    if (cd) {
      const arg = cdArgument(cd[1])
      const base: string | null = dir ?? cwd
      // An absolute cd resets even an unknown directory; a relative one after it stays unknown.
      dir = arg === null || (!arg.startsWith('/') && (dir === undefined || !base)) ? undefined : resolvePosix(base ?? '/', arg)
      continue
    }
    if (segment === 'popd') {
      dir = undefined
      continue
    }
    const match = BBPR_AT_START.exec(segment)
    const number = match ? Number(match[1]) : 0
    if (number <= 0) continue
    out.push(dir === null ? { number, runsIn: 'cwd' } : dir === undefined ? { number, runsIn: 'unknown' } : { number, runsIn: 'dir', dir })
  }
  return out
}
