/**
 * Which pull requests a shell command works on, for auto-linking a chat to
 * them. A PR the agent opens, checks out, merges, edits, comments on or
 * reviews with gh, or fetches for review with bbpr, counts. A read
 * (`gh pr view`, `diff`, `checks`, `list`) or a URL inside a quoted argument
 * (a PR body naming another PR) does not.
 */
import { shellSegments } from './bbpr-command'

const GH_PR_WORKS_ON = new Set(['create', 'checkout', 'co', 'merge', 'edit', 'comment', 'review', 'ready', 'close', 'reopen'])

/** Words of one command segment, split on whitespace outside quotes; a quoted word keeps its quotes. */
function words(segment: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

export interface PrCommandLinks {
  /** The PR URLs the command hands to gh or bbpr as the PR it works on. */
  urls: string[]
  /** It runs `gh pr create`, which prints the new PR's URL. */
  creates: boolean
}

export function prCommandLinks(command: string): PrCommandLinks {
  const urls: string[] = []
  let creates = false
  if (!command.includes('gh') && !command.includes('bbpr')) return { urls, creates }
  for (const segment of shellSegments(command)) {
    const [program = '', ...args] = words(segment)
    const name = program.slice(program.lastIndexOf('/') + 1)
    let rest: string[]
    if (name === 'gh' && args[0] === 'pr' && GH_PR_WORKS_ON.has(args[1] ?? '')) {
      if (args[1] === 'create') creates = true
      rest = args.slice(2)
    } else if (name === 'bbpr') {
      rest = args.slice(0, 1)
    } else {
      continue
    }
    const url = rest.find((word) => /^https?:\/\//.test(word))
    if (url) urls.push(url)
  }
  return { urls, creates }
}
