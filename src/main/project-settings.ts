/**
 * Per-project setting overrides, stored as `project:<pathKey>:<settingKey>`
 * rows of the settings table (the format and why are in
 * `shared/project-settings.ts`). The backend resolves them, so the desktop, a
 * remote backend and the phone all see the same effective value.
 */
import { getSetting, listSettingsWithPrefix, removeSetting, setSetting } from './db/database'
import { pathKey } from './worktree'
import { createMainLogger } from './logger'
import {
  PROJECT_OVERRIDE_PREFIX,
  effectiveSetting,
  isScopableSetting,
  parseProjectOverrideKey,
  projectOverrideKey,
  scopableSetting,
  type ProjectOverrides,
  type ScopableSettingKey,
  type SettingReader,
} from '@shared/project-settings'

const log = createMainLogger('settings:project')

// A newer build's scopable setting is logged once per process, not on every read.
const reportedUnknown = new Set<string>()

function reportUnknown(settingKey: string): void {
  if (reportedUnknown.has(settingKey)) return
  reportedUnknown.add(settingKey)
  log.warn(`ignoring project overrides of ${settingKey}: not a scopable setting in this build`)
}

/** Every stored override, by project key. Unknown setting keys are skipped, not deleted, so a newer build sharing the DB keeps them. */
function allOverrides(): Map<string, ProjectOverrides> {
  const byProject = new Map<string, ProjectOverrides>()
  for (const { key, value } of listSettingsWithPrefix(PROJECT_OVERRIDE_PREFIX)) {
    const parsed = parseProjectOverrideKey(key)
    if (!parsed) continue
    if (!isScopableSetting(parsed.settingKey)) {
      reportUnknown(parsed.settingKey)
      continue
    }
    const overrides = byProject.get(parsed.projectKey) ?? {}
    overrides[parsed.settingKey] = value
    byProject.set(parsed.projectKey, overrides)
  }
  return byProject
}

/** The overrides of each requested project, keyed by the path as the caller spelled it. */
export function listProjectOverrides(projectPaths: readonly string[]): Record<string, ProjectOverrides> {
  const all = allOverrides()
  return Object.fromEntries(projectPaths.map((path) => [path, all.get(pathKey(path)) ?? {}]))
}

function requireScopable(settingKey: unknown): ScopableSettingKey {
  if (!isScopableSetting(settingKey)) throw new Error(`${String(settingKey)} cannot be set per project`)
  return settingKey
}

export function setProjectOverride(projectPath: string, settingKey: unknown, value: unknown): void {
  const key = requireScopable(settingKey)
  if (typeof projectPath !== 'string' || !projectPath) throw new Error('a project path is required')
  if (typeof value !== 'string' || !scopableSetting(key).accepts(value)) {
    throw new Error(`${String(value)} is not a value ${key} accepts`)
  }
  setSetting(projectOverrideKey(pathKey(projectPath), key), value)
}

export function removeProjectOverride(projectPath: string, settingKey: unknown): void {
  const key = requireScopable(settingKey)
  if (typeof projectPath !== 'string' || !projectPath) throw new Error('a project path is required')
  removeSetting(projectOverrideKey(pathKey(projectPath), key))
}

const backendReader: SettingReader = {
  override: (projectPath, key) => getSetting(projectOverrideKey(pathKey(projectPath), key)),
  global: (key) => getSetting(key),
}

/** Override ?? global ?? default, for a backend-owned consumer. */
export function effectiveBackendSetting(key: ScopableSettingKey, projectPath: string | null | undefined): string {
  return effectiveSetting(key, projectPath, backendReader)
}

/**
 * What `settings:get(key, projectPath)` answers: the override when the
 * project has a valid one, else the raw global row. Raw, not defaulted, so
 * a caller that treats null as "not configured" behaves as it did before
 * project scopes.
 */
export function getSettingForProject(key: string, projectPath: unknown): string | null {
  if (typeof projectPath !== 'string' || !projectPath || !isScopableSetting(key)) return getSetting(key)
  const override = getSetting(projectOverrideKey(pathKey(projectPath), key))
  if (override != null && scopableSetting(key).accepts(override)) return override
  return getSetting(key)
}
