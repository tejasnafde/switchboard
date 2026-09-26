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
 * Case-insensitive substring match on the label, hint and keywords. Order is
 * kept as given: callers order the list on purpose (recent first), and a
 * fuzzy score would reshuffle it on every keystroke.
 */
export function filterComboboxOptions(options: ComboboxOption[], query: string): ComboboxOption[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return options
  return options.filter((option) =>
    [option.label, option.hint, ...(option.keywords ?? [])].some((text) => text?.toLowerCase().includes(needle)),
  )
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
