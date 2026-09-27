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
