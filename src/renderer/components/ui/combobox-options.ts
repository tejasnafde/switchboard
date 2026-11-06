import { scoreSearchWord } from '@shared/model-search'

/** One row of a Combobox. `group` names the heading it sits under, in first-seen order. */
export interface ComboboxOption {
  value: string
  label: string
  /** Name to rank when the displayed label also includes context, such as a machine. */
  searchLabel?: string
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

/** Name tiers win over paths and fuzzy matches; ties keep the caller's order. */
export function filterComboboxOptions(options: ComboboxOption[], query: string): ComboboxOption[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return options
  const tiers: ComboboxOption[][] = [[], [], [], [], [], []]
  for (const option of options) {
    const label = (option.searchLabel ?? option.label).toLowerCase()
    const nameScore = scoreSearchWord(needle, label)
    const extraMatch = [option.label, option.hint, ...(option.keywords ?? [])].some((text) =>
      text?.toLowerCase().includes(needle),
    )
    if (label === needle) tiers[0].push(option)
    else if (nameScore === 3) tiers[1].push(option)
    else if (nameScore === 2) tiers[2].push(option)
    else if (nameScore === 1) tiers[3].push(option)
    else if (extraMatch) tiers[4].push(option)
    else if (nameScore > 0) tiers[5].push(option)
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
