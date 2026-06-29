/**
 * Tiny gitignore matcher - annotates (never filters) entries for the file
 * tree pane so users can still see/click `node_modules/` etc. but rendered
 * greyed out (VS Code style).
 *
 * Supports the patterns common in JS/Python repos:
 *   - bare names (`node_modules`, `dist`)
 *   - leading-slash anchored to root (`/build`)
 *   - trailing-slash directory-only (`logs/`)
 *   - glob `*` and `?` (single segment)
 *   - `!` negation (later rules win)
 *   - blank lines + `#` comments ignored
 *
 * Not aiming for full git semantics - no nested `.gitignore` composition,
 * no `**` recursion subtleties. Good enough for the visual cue.
 */
export interface GitignoreRule {
  pattern: string
  negate: boolean
  dirOnly: boolean
  anchored: boolean
  /** Compiled regex applied to a candidate path segment or full relpath. */
  regex: RegExp
}

/** Convert a single gitignore pattern (sans flags) to a JS regex source. */
function patternToRegexSource(pattern: string): string {
  let src = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') {
      // `**` crosses segments; `**/foo` matches `foo` at any depth.
      i++
      if (pattern[i + 1] === '/') {
        i++
        src += '(?:.*/)?'
      } else {
        src += '.*'
      }
    } else if (ch === '*') src += '[^/]*'
    else if (ch === '?') src += '[^/]'
    else if ('.+^$(){}|[]\\'.includes(ch)) src += '\\' + ch
    else src += ch
  }
  return src
}

export function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#')) continue

    let pattern = line
    let negate = false
    if (pattern.startsWith('!')) {
      negate = true
      pattern = pattern.slice(1)
    }

    let anchored = false
    if (pattern.startsWith('/')) {
      anchored = true
      pattern = pattern.slice(1)
    }

    let dirOnly = false
    if (pattern.endsWith('/')) {
      dirOnly = true
      pattern = pattern.slice(0, -1)
    }

    if (!pattern) continue

    let regex: RegExp
    try {
      const src = patternToRegexSource(pattern)
      // Anchored (leading slash): match from root. Bare name (no slash):
      // match any path segment. A slash mid-pattern (e.g. `foo/bar`) is also
      // root-relative per gitignore semantics - not matched at arbitrary depth.
      // Case-insensitive to mirror git core.ignorecase on macOS/Windows.
      if (anchored || pattern.includes('/')) {
        regex = new RegExp('^' + src + '$', 'i')
      } else {
        regex = new RegExp('(^|/)' + src + '$', 'i')
      }
    } catch {
      // Malformed pattern - install a never-matches sentinel so callers
      // don't crash on weird input.
      regex = /a^/
    }

    rules.push({ pattern, negate, dirOnly, anchored, regex })
  }
  return rules
}

/**
 * Check whether a repo-relative path is ignored. `isDir` controls
 * directory-only patterns. Later rules override earlier ones (gitignore
 * semantics) - so a `!keep.log` after `*.log` un-ignores `keep.log`.
 */
export function isIgnored(relPath: string, isDir: boolean, rules: GitignoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.regex.test(relPath)) {
      ignored = !rule.negate
    }
  }
  return ignored
}
