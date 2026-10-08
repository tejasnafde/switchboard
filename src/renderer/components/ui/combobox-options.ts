/** One row of a Combobox. `group` names the heading it sits under, in first-seen order. */
export interface ComboboxOption {
  value: string
  label: string
  /** Muted text on the right of the row. */
  hint?: string
  group?: string
  /** Extra text the search matches besides the label (a path, an alias). */
  keywords?: string[]
}

export interface ComboboxGroup {
  heading: string | undefined
  options: ComboboxOption[]
}

/**
 * Case-insensitive substring match on the label, hint and keywords. Callers
 * order the list on purpose (recent first), so a fuzzy score would reshuffle
 * it on every keystroke. Only the label tier moves a row: an exact label, then
 * a label that starts with the query, then one that contains it, then rows
 * matched only by hint or keyword (a path). Each tier keeps the given order.
 * Without the tiers, a query that every path contains ("projects") would bury
 * the row whose name it is.
 */
export function filterComboboxOptions(options: ComboboxOption[], query: string): ComboboxOption[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return options
  const tiers: ComboboxOption[][] = [[], [], [], []]
  for (const option of options) {
    const label = option.label.toLowerCase()
    if (label === needle) tiers[0].push(option)
    else if (label.startsWith(needle)) tiers[1].push(option)
    else if (label.includes(needle)) tiers[2].push(option)
    else if ([option.hint, ...(option.keywords ?? [])].some((text) => text?.toLowerCase().includes(needle)))
      tiers[3].push(option)
  }
  return tiers.flat()
}

/** Options with the same `group` share one heading, placed where that group first appears. */
export function groupComboboxOptions(options: ComboboxOption[]): ComboboxGroup[] {
  const groups: ComboboxGroup[] = []
  const byHeading = new Map<string | undefined, ComboboxGroup>()
  for (const option of options) {
    let group = byHeading.get(option.group)
    if (!group) {
      group = { heading: option.group, options: [] }
      byHeading.set(option.group, group)
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups
}
