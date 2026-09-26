/**
 * Settings a project can override, and how an override is stored and read.
 *
 * Storage: one row of the ordinary `settings` table per override, keyed
 * `project:<pathKey>:<settingKey>`. One row per override, not one JSON value
 * per project, because two clients (the desktop and a phone, or two desktop
 * windows) writing different overrides of one project would otherwise race a
 * read-modify-write of the same value and one edit would be lost. Rows also
 * reuse the existing get/set/remove path and its per-key write gate. The path
 * part is the backend's `pathKey` (realpath, lower-case on Windows), so every
 * spelling of a project's folder lands on the same rows; it may itself hold
 * a `:` (a Windows drive), which is why the setting key is read from the
 * right. A setting key never holds a `:`.
 *
 * Resolution: project override ?? global value ?? default, each tier skipped
 * when its value is not one the setting accepts, so an override written by a
 * newer build with a value this build does not know falls through.
 */
import { FOLLOW_UP_DEFAULT_KEY } from './turn-delivery'
import { FALLBACK_RUNTIME_MODE, SETTING_DEFAULT_RUNTIME_MODE } from './session-defaults'
import { isRuntimeMode } from './provider-events'

export interface ScopableSetting {
  /** The global settings key; an override is stored beside it under the project prefix. */
  key: string
  /** The value when neither the project nor the global tier has a valid one. */
  defaultValue: string
  accepts: (value: string) => boolean
}

export const SETTING_SESSION_ENV_MODE = 'defaultSessionEnvMode'
export const SETTING_SHOW_FILE_DIFFS = 'chat.showFileDiffs'

const oneOf = (...values: string[]) => (value: string) => values.includes(value)

/**
 * Every setting a project can override. Only what varies by project belongs
 * here: global app behaviour (theme, notifications, updates, keyboard) does
 * not. Adding a scopable setting is one line.
 */
export const SCOPABLE_SETTINGS = [
  { key: FOLLOW_UP_DEFAULT_KEY, defaultValue: 'steer', accepts: oneOf('steer', 'queue') },
  { key: SETTING_DEFAULT_RUNTIME_MODE, defaultValue: FALLBACK_RUNTIME_MODE, accepts: isRuntimeMode },
  { key: SETTING_SESSION_ENV_MODE, defaultValue: 'local', accepts: oneOf('local', 'worktree') },
  { key: SETTING_SHOW_FILE_DIFFS, defaultValue: 'false', accepts: oneOf('true', 'false') },
] as const satisfies readonly ScopableSetting[]

export type ScopableSettingKey = (typeof SCOPABLE_SETTINGS)[number]['key']

const BY_KEY = new Map<string, ScopableSetting>(SCOPABLE_SETTINGS.map((s) => [s.key, s]))

export function isScopableSetting(key: unknown): key is ScopableSettingKey {
  return typeof key === 'string' && BY_KEY.has(key)
}

export function scopableSetting(key: ScopableSettingKey): ScopableSetting {
  return BY_KEY.get(key)!
}

export const PROJECT_OVERRIDE_PREFIX = 'project:'

export function projectOverrideKey(projectKey: string, settingKey: string): string {
  return `${PROJECT_OVERRIDE_PREFIX}${projectKey}:${settingKey}`
}

/** The parts of a stored override key, or null for any other key. The setting key may be one this build does not know. */
export function parseProjectOverrideKey(storedKey: string): { projectKey: string; settingKey: string } | null {
  if (!storedKey.startsWith(PROJECT_OVERRIDE_PREFIX)) return null
  const rest = storedKey.slice(PROJECT_OVERRIDE_PREFIX.length)
  const split = rest.lastIndexOf(':')
  if (split <= 0 || split === rest.length - 1) return null
  return { projectKey: rest.slice(0, split), settingKey: rest.slice(split + 1) }
}

/** The setting a stored key governs: itself, or the one a project override overrides. */
export function governedSettingKey(storedKey: string): string {
  return parseProjectOverrideKey(storedKey)?.settingKey ?? storedKey
}

export type SettingSource = 'project' | 'global' | 'default'

export interface SettingReader {
  /** The raw override for this project, if any. */
  override: (projectPath: string, key: ScopableSettingKey) => string | null | undefined
  global: (key: ScopableSettingKey) => string | null | undefined
}

export function resolveSetting(
  key: ScopableSettingKey,
  projectPath: string | null | undefined,
  reader: SettingReader,
): { value: string; source: SettingSource } {
  const setting = scopableSetting(key)
  const override = projectPath ? reader.override(projectPath, key) : undefined
  if (override != null && setting.accepts(override)) return { value: override, source: 'project' }
  const global = reader.global(key)
  if (global != null && setting.accepts(global)) return { value: global, source: 'global' }
  return { value: setting.defaultValue, source: 'default' }
}

/** Project override ?? global value ?? default. No project means the global value. */
export function effectiveSetting(
  key: ScopableSettingKey,
  projectPath: string | null | undefined,
  reader: SettingReader,
): string {
  return resolveSetting(key, projectPath, reader).value
}

/** One project's overrides, by setting key. What the backend returns per requested path. */
export type ProjectOverrides = Partial<Record<ScopableSettingKey, string>>
