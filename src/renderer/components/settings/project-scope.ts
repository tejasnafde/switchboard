/**
 * The Chat & agents Scope control and the Projects page, as pure rules: which
 * options the Scope combobox lists, what a row shows in a project's scope,
 * and how a project's summary line reads.
 */
import type { Workspace } from '@shared/types'
import { parseLaunchConfigFile } from '@shared/launch-config'
import { isScopableSetting, type ProjectOverrides } from '@shared/project-settings'
import type { ComboboxOption } from '../ui/combobox-options'
import { projectPickerOptions, type PickerProject } from './project-picker-options'
import type { SettingRowDef } from './settings-rows'

/** The Scope value for "All projects"; a project scope is its path. */
export const ALL_PROJECTS_SCOPE = '__all-projects__'

export const NOT_SCOPABLE_REASON = 'Applies to all projects.'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Overrides of settings this build knows; anything else in the map is ignored. */
export function overrideCount(overrides: ProjectOverrides | undefined): number {
  return Object.keys(overrides ?? {}).filter(isScopableSetting).length
}

/** "All projects" first, then the project picker's Recent and workspace groups, each with its override count. */
export function scopeOptions(
  projects: PickerProject[],
  workspaces: Workspace[],
  byProject: Readonly<Record<string, ProjectOverrides>>,
): ComboboxOption[] {
  const all: ComboboxOption = { value: ALL_PROJECTS_SCOPE, label: 'All projects' }
  return [all, ...projectPickerOptions(projects, workspaces).map((option) => {
    const count = overrideCount(byProject[option.value])
    const hint = [option.hint, count > 0 ? plural(count, 'override') : undefined].filter(Boolean).join(' · ')
    return { ...option, hint: hint || undefined }
  })]
}

export interface ScopedRow {
  /** What the control shows: the override, else the All projects value. */
  value: string | undefined
  overridden: boolean
  /** Set when the row cannot be edited in this scope. */
  disabledReason?: string
}

/**
 * A row in a project's scope. Scopable rows show the effective value and
 * write an override; any other row on a scoped page is disabled, since
 * editing it would change every project while a single one is picked.
 */
export function scopedRow(
  row: SettingRowDef,
  scope: string | null,
  globalValue: string | undefined,
  overrides: ProjectOverrides | undefined,
): ScopedRow {
  // Only Chat & agents has a Scope control.
  if (!scope || row.page !== 'chat') return { value: globalValue, overridden: false }
  if (!row.scopeKey) return { value: globalValue, overridden: false, disabledReason: NOT_SCOPABLE_REASON }
  const override = overrides?.[row.scopeKey]
  return override === undefined
    ? { value: globalValue, overridden: false }
    : { value: override, overridden: true }
}

/** How a value reads: its option label, On/Off for a switch, else the raw value. */
export function valueLabel(row: SettingRowDef, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const option = row.options?.find((o) => o.value === value)
  if (option) return option.label
  if (value === 'true') return 'On'
  if (value === 'false') return 'Off'
  return value
}

/** The Projects page line: "3 launch configs · 2 overrides". A count still loading is left out. */
export function projectSummary(launchConfigs: number | undefined, overrides: number): string {
  const parts = [
    launchConfigs === undefined ? undefined : plural(launchConfigs, 'launch config'),
    plural(overrides, 'override'),
  ]
  return parts.filter(Boolean).join(' · ')
}

/** Named launch configs in a project's launch-config.yaml; none for a missing file. Throws on invalid YAML. */
export function launchConfigCount(yaml: string | null): number {
  if (yaml === null) return 0
  return Object.keys(parseLaunchConfigFile(yaml).configs ?? {}).length
}
