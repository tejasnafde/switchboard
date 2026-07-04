/** Directory autocomplete for a typed absolute path (remote add-project). */

/** Split a typed path into the parent dir to list and the partial last segment. */
export function splitPath(typed: string): { dir: string; partial: string } {
  const idx = typed.lastIndexOf('/')
  if (idx <= 0) return { dir: '/', partial: typed.slice(idx + 1) }
  return { dir: typed.slice(0, idx), partial: typed.slice(idx + 1) }
}

/** Full-path completions for the directories in `entries` matching the partial. */
export function pathCompletions(typed: string, entries: Array<{ name: string; isDir: boolean }>): string[] {
  const { dir, partial } = splitPath(typed)
  const base = dir === '/' ? '' : dir
  const p = partial.toLowerCase()
  return entries
    .filter((e) => e.isDir && e.name.toLowerCase().startsWith(p))
    // Visible folders before dot-folders - otherwise dot-folders (which sort
    // first) fill the suggestion cap and hide the ones the user usually wants.
    // Typing a leading '.' still narrows to dot-folders via the filter above.
    .sort((a, b) => {
      const ad = a.name.startsWith('.')
      const bd = b.name.startsWith('.')
      if (ad !== bd) return ad ? 1 : -1
      return a.name.localeCompare(b.name)
    })
    .map((e) => `${base}/${e.name}`)
}

/** Wrapping ArrowUp/ArrowDown movement over a suggestion list; -1 means "no selection". */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count === 0) return -1
  return (current + delta + count) % count
}

/** Turn an accepted suggestion into the next input value - trailing '/' so the user can keep typing. */
export function acceptSuggestion(suggestion: string): string {
  return suggestion.endsWith('/') ? suggestion : `${suggestion}/`
}
