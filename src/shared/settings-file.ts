/**
 * `settings.json`: the Settings page as a file, for power users.
 *
 * The settings DB stays the source of truth. The file is a projection of it:
 * Open writes it from the DB, a save in an editor is parsed and applied back
 * through the ordinary write paths, and a change made in the UI rewrites it.
 *
 * Shape, and why:
 *
 *   { "$schema": "./settings.schema.json",
 *     "settings": { "<settings key>": <value> },
 *     "projects": { "<project path>": { "<scopable key>": <value> } },
 *     "keyboard": { "<command id>": ["Mod+Shift+P"] } }
 *
 * - Three sections, because they are three stores with three sets of rules
 *   (a plain row, a per-project override row, one JSON row of rebinds), and
 *   a flat file would need a key syntax to tell them apart.
 * - Keys are the settings DB keys, the same strings the backend and the phone
 *   read, so a project override and the global value it overrides share one
 *   name (`chat.defaultRuntimeMode` in both sections).
 * - Values are typed JSON (`true`, `8`), not the DB's strings, so the schema
 *   can offer completion and flag `"yes"` in an editor.
 * - Only values that differ from the default are written, so the file reads
 *   as "what I changed". A key removed from the file goes back to its default.
 *
 * Only settings on the allow-list below are ever read or written. Everything
 * else in the table (provider credentials, pairing, device sessions, window
 * state, per-conversation state) never reaches the file, and a key in the file
 * that is not on the list is refused, not written.
 *
 * Pure: the IO, watching and guards live in `main/settings-file.ts`.
 */
import { FOLLOW_UP_DEFAULT_KEY } from './turn-delivery'
import { SETTING_DEFAULT_RUNTIME_MODE } from './session-defaults'
import { RUNTIME_MODES } from './provider-events'
import {
  SCOPABLE_SETTINGS,
  SETTING_SESSION_ENV_MODE,
  SETTING_SHOW_FILE_DIFFS,
  isScopableSetting,
  parseProjectOverrideKey,
} from './project-settings'
import {
  KEYBOARD_OVERRIDES_SETTING,
  SHORTCUTS,
  applyShortcutOverrides,
  currentPlatform,
  isRebindable,
  parseBinding,
  reservedShortcutReason,
  shortcutClashesFor,
  type ShortcutCommand,
  type ShortcutPlatform,
} from './shortcuts'

export const SETTINGS_FILE_NAME = 'settings.json'
export const SETTINGS_SCHEMA_FILE_NAME = 'settings.schema.json'
/** Internal settings row: sha256 of what the file held when Switchboard last wrote or fully applied it. Never in the file. */
export const SETTINGS_FILE_SYNCED_HASH_KEY = 'settingsFile.syncedHash'

type FileValue = string | number | boolean

export interface FileSetting {
  /** The settings DB key, also the key in the file. */
  key: string
  /** What the Settings page calls it, for the schema's description. */
  label: string
  /** Stored form of the default: a missing row reads as this. */
  defaultValue: string
  type: 'boolean' | 'number' | 'string'
  /** The values the setting accepts, in their file form. None means any value of `type` that `accepts` takes. */
  choices?: readonly FileValue[]
  /** Whether a STORED value is one the setting accepts. */
  accepts: (stored: string) => boolean
  /** Why a file value was refused, for the banner. */
  expected: string
}

const flagSetting = (key: string, label: string, defaultValue: 'true' | 'false'): FileSetting => ({
  key, label, defaultValue, type: 'boolean', accepts: (v) => v === 'true' || v === 'false', expected: 'true or false',
})

const choiceSetting = (key: string, label: string, defaultValue: string, choices: readonly string[]): FileSetting => ({
  key, label, defaultValue, type: 'string', choices, accepts: (v) => choices.includes(v),
  expected: `one of ${choices.map((c) => `"${c}"`).join(', ')}`,
})

const scopable = (key: string) => SCOPABLE_SETTINGS.find((s) => s.key === key)!.defaultValue

/** Mirrors `RECENT_SESSION_LIMITS` in the sidebar (a test keeps them equal). */
const RECENT_LIMITS = [4, 6, 8, 12] as const
const THEMES = ['dark', 'light', 'translucent', 'system'] as const

/**
 * The allow-list: every value-holding row of the Settings page except the
 * keyboard rows (their own section). Each entry is the key its row writes,
 * with the default and values that row uses (a test holds the two together).
 */
export const FILE_SETTINGS: readonly FileSetting[] = [
  flagSetting('notificationsEnabled', 'Notify when an agent finishes a turn', 'true'),
  {
    key: 'sidebar.recentSessionLimit', label: 'Recent conversations', defaultValue: '4', type: 'number',
    choices: RECENT_LIMITS, accepts: (v) => RECENT_LIMITS.some((n) => String(n) === v), expected: `one of ${RECENT_LIMITS.join(', ')}`,
  },
  {
    key: 'ide.idleTtlMinutes', label: 'Shut down the embedded IDE when hidden after (minutes)', defaultValue: '5', type: 'number',
    accepts: (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0, expected: 'a number of minutes above 0',
  },
  flagSetting('analytics.enabled', 'Share anonymous usage counts', 'true'),
  choiceSetting('theme', 'Theme', 'dark', THEMES),
  choiceSetting(FOLLOW_UP_DEFAULT_KEY, 'Follow-up while the agent works', scopable(FOLLOW_UP_DEFAULT_KEY), ['steer', 'queue']),
  flagSetting('assistantStreamingEnabled', 'Stream assistant messages', 'true'),
  choiceSetting(SETTING_SESSION_ENV_MODE, 'Recommended workspace', scopable(SETTING_SESSION_ENV_MODE), ['local', 'worktree']),
  choiceSetting(SETTING_DEFAULT_RUNTIME_MODE, 'Runtime mode for new chats', scopable(SETTING_DEFAULT_RUNTIME_MODE), RUNTIME_MODES),
  flagSetting(SETTING_SHOW_FILE_DIFFS, 'Show file diff cards in chat', scopable(SETTING_SHOW_FILE_DIFFS) as 'true' | 'false'),
  flagSetting('tour.autoplay', 'Auto-open the tour after a release adds new features', 'true'),
]

const BY_KEY = new Map(FILE_SETTINGS.map((s) => [s.key, s]))

export function fileSetting(key: string): FileSetting | undefined {
  return BY_KEY.get(key)
}

/** The stored string as it reads in the file. */
function toFileValue(setting: FileSetting, stored: string): FileValue {
  if (setting.type === 'boolean') return stored === 'true'
  if (setting.type === 'number') return Number(stored)
  return stored
}

/** The file value as stored, or null when the setting does not take it. */
function toStored(setting: FileSetting, value: unknown): string | null {
  if (typeof value !== setting.type) return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  const stored = String(value)
  return setting.accepts(stored) ? stored : null
}

/** A stored value that reads the same as the default: the row a UI toggle back leaves behind. */
function isEffectivelyDefault(setting: FileSetting, stored: string | undefined): boolean {
  return stored === undefined || !setting.accepts(stored) || stored === setting.defaultValue
}

/** What the file is built from and compared against: the allow-listed rows only. */
export interface SettingsSnapshot {
  /** Allow-listed global rows, by key. */
  settings: Readonly<Record<string, string>>
  /** Stored overrides of scopable settings, by project key, then setting key. */
  projects: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** The parsed `keyboard.overrides` row, ids another build wrote included. */
  keyboard: Readonly<Record<string, unknown>>
}

export interface SettingsFile {
  $schema: string
  settings: Record<string, FileValue>
  projects: Record<string, Record<string, FileValue>>
  keyboard: Record<string, string[]>
}

/**
 * The file for this snapshot: values that differ from the default, nothing
 * else. `projectLabel` spells a project key as the project list does.
 */
export function projectSettingsFile(
  snapshot: SettingsSnapshot,
  opts: { projectLabel?: (projectKey: string) => string; platform?: ShortcutPlatform } = {},
): SettingsFile {
  const settings: Record<string, FileValue> = {}
  for (const setting of FILE_SETTINGS) {
    const stored = snapshot.settings[setting.key]
    if (!isEffectivelyDefault(setting, stored)) settings[setting.key] = toFileValue(setting, stored!)
  }

  const projects: Record<string, Record<string, FileValue>> = {}
  for (const projectKey of Object.keys(snapshot.projects).sort()) {
    const entry: Record<string, FileValue> = {}
    for (const [key, stored] of Object.entries(snapshot.projects[projectKey])) {
      const setting = fileSetting(key)
      // An override that equals the global default still pins the project, so it stays.
      if (setting && isScopableSetting(key) && setting.accepts(stored)) entry[key] = toFileValue(setting, stored)
    }
    if (Object.keys(entry).length > 0) projects[opts.projectLabel?.(projectKey) ?? projectKey] = entry
  }

  // Only rebinds this build applies: another build's ids and refused values stay in the DB, out of the file.
  const keyboard: Record<string, string[]> = {}
  const { ignored } = applyShortcutOverrides(snapshot.keyboard, SHORTCUTS, opts.platform ?? currentPlatform())
  for (const [id, bindings] of Object.entries(snapshot.keyboard)) {
    if (!ignored.includes(id)) keyboard[id] = bindings as string[]
  }

  return { $schema: `./${SETTINGS_SCHEMA_FILE_NAME}`, settings, projects, keyboard }
}

export function serializeSettingsFile(file: SettingsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/** One write the file asks for, in the terms of the existing write paths. */
export type SettingsFileOp =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string }
  | { kind: 'project-set'; projectPath: string; key: string; value: string }
  | { kind: 'project-remove'; projectKey: string; key: string }
  /** The whole `keyboard.overrides` value; the existing row is one JSON object. */
  | { kind: 'keyboard'; value: string }

export interface SkippedEntry {
  /** Where in the file, as a reader would name it: `settings.theme`, `keyboard.app.search`. */
  entry: string
  reason: string
}

export type SettingsFilePlan =
  | { ok: true; ops: SettingsFileOp[]; skipped: SkippedEntry[] }
  | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Why the file wants `id` bound to `value` and cannot have it, given every other rebind in `commands`. */
function shortcutRefusal(
  id: string,
  value: unknown,
  byId: ReadonlyMap<string, ShortcutCommand>,
  commands: readonly ShortcutCommand[],
  platform: ShortcutPlatform,
): string {
  const command = byId.get(id)
  if (!command) return 'not a command in this version of Switchboard'
  if (!isRebindable(command)) return 'this shortcut cannot be rebound'
  if (!Array.isArray(value) || !value.every((b) => typeof b === 'string')) return 'expected a list of keys, like ["Mod+Shift+P"]'
  for (const binding of value as string[]) {
    if (!parseBinding(binding)) return `"${binding}" is not a key combination`
    const reserved = reservedShortcutReason(binding, platform)
    if (reserved) return `"${binding}": ${reserved}`
  }
  for (const binding of value as string[]) {
    const clash = shortcutClashesFor(id, binding, platform, commands)[0]
    if (clash) return `"${binding}" is already ${clash.label}`
  }
  return 'clashes with another shortcut'
}

/**
 * The writes that make the DB match `text`, and the entries refused on the
 * way. Invalid JSON, or JSON that is not an object, plans nothing. A refused
 * entry leaves its setting as it is; only a key absent from the file resets.
 * Only values that actually change become writes, so saving an untouched file
 * writes nothing.
 */
export function planSettingsFileApply(
  text: string,
  current: SettingsSnapshot,
  opts: { projectKey: (projectPath: string) => string; platform?: ShortcutPlatform },
): SettingsFilePlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` }
  }
  if (!isObject(parsed)) return { ok: false, error: 'the file must hold one JSON object' }

  const ops: SettingsFileOp[] = []
  const skipped: SkippedEntry[] = []
  // A section that is not an object is refused whole, so its settings stay as they are.
  const section = (name: 'settings' | 'projects' | 'keyboard'): Record<string, unknown> | null => {
    const value = parsed[name]
    if (value === undefined) return {}
    if (isObject(value)) return value
    skipped.push({ entry: name, reason: 'expected an object' })
    return null
  }
  for (const key of Object.keys(parsed)) {
    if (!['$schema', 'settings', 'projects', 'keyboard'].includes(key)) skipped.push({ entry: key, reason: 'not a section of this file' })
  }

  // Global settings.
  const settings = section('settings')
  if (settings) {
    for (const [key, value] of Object.entries(settings)) {
      const setting = fileSetting(key)
      if (!setting) {
        skipped.push({ entry: `settings.${key}`, reason: 'not a setting this file can change' })
        continue
      }
      const stored = toStored(setting, value)
      if (stored === null) {
        skipped.push({ entry: `settings.${key}`, reason: `expected ${setting.expected}` })
        continue
      }
      if (current.settings[key] !== stored) ops.push({ kind: 'set', key, value: stored })
    }
    for (const setting of FILE_SETTINGS) {
      if (!(setting.key in settings) && !isEffectivelyDefault(setting, current.settings[setting.key])) {
        ops.push({ kind: 'remove', key: setting.key })
      }
    }
  }

  // Project overrides, compared by project key so any spelling of a folder lands on its rows.
  const projects = section('projects')
  if (projects) {
    const kept = new Map<string, Set<string>>()
    for (const [projectPath, overrides] of Object.entries(projects)) {
      if (!projectPath.trim()) {
        skipped.push({ entry: 'projects.""', reason: 'a project needs its folder path' })
        continue
      }
      const projectKey = opts.projectKey(projectPath)
      const keep = kept.get(projectKey) ?? new Set<string>()
      kept.set(projectKey, keep)
      if (!isObject(overrides)) {
        skipped.push({ entry: `projects.${projectPath}`, reason: 'expected an object of settings' })
        // Refused as a whole: leave every override of this project as it is.
        for (const key of Object.keys(current.projects[projectKey] ?? {})) keep.add(key)
        continue
      }
      for (const [key, value] of Object.entries(overrides)) {
        const setting = fileSetting(key)
        if (!setting || !isScopableSetting(key)) {
          skipped.push({ entry: `projects.${projectPath}.${key}`, reason: 'not a setting a project can override' })
          continue
        }
        keep.add(key)
        const stored = toStored(setting, value)
        if (stored === null) {
          skipped.push({ entry: `projects.${projectPath}.${key}`, reason: `expected ${setting.expected}` })
          continue
        }
        if (current.projects[projectKey]?.[key] !== stored) ops.push({ kind: 'project-set', projectPath, key, value: stored })
      }
    }
    for (const [projectKey, overrides] of Object.entries(current.projects)) {
      for (const key of Object.keys(overrides)) {
        if (isScopableSetting(key) && !kept.get(projectKey)?.has(key)) ops.push({ kind: 'project-remove', projectKey, key })
      }
    }
  }

  // Keyboard: the result must satisfy the same rules `applyShortcutOverrides` enforces when it binds.
  const keyboard = section('keyboard')
  if (keyboard) {
    const platform = opts.platform ?? currentPlatform()
    const byId = new Map(SHORTCUTS.map((c) => [c.id, c]))
    const { commands, ignored } = applyShortcutOverrides(keyboard, SHORTCUTS, platform)
    const next: Record<string, unknown> = {}
    // Another build's rebinds are not this file's to delete.
    for (const [id, value] of Object.entries(current.keyboard)) if (!byId.has(id)) next[id] = value
    for (const [id, value] of Object.entries(keyboard)) {
      if (!ignored.includes(id)) {
        next[id] = value
        continue
      }
      skipped.push({ entry: `keyboard.${id}`, reason: shortcutRefusal(id, value, byId, commands, platform) })
      // A refused rebind keeps what is stored, unless what is stored no longer fits.
      if (byId.has(id) && id in current.keyboard) next[id] = current.keyboard[id]
    }
    // A kept old value can clash with the file's new ones; binding would drop it anyway, so do it here.
    const { ignored: stale } = applyShortcutOverrides(next, SHORTCUTS, platform)
    for (const id of stale) if (byId.has(id)) delete next[id]
    if (JSON.stringify(sortKeys(next)) !== JSON.stringify(sortKeys(current.keyboard))) {
      ops.push({ kind: 'keyboard', value: JSON.stringify(next) })
    }
  }

  return { ok: true, ops, skipped }
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]))
}

/** One line for the banner: the first few refusals, and how many more. */
export function describeSkipped(skipped: readonly SkippedEntry[], limit = 2): string {
  if (skipped.length === 0) return ''
  const shown = skipped.slice(0, limit).map((s) => `${s.entry} (${s.reason})`).join('; ')
  const more = skipped.length - limit
  return more > 0 ? `${shown}; and ${more} more` : shown
}

/**
 * JSON Schema (draft-07) for the file, from the same definitions the parser
 * checks, so the embedded IDE completes keys and flags a value before save.
 */
export function settingsFileSchema(platform: ShortcutPlatform = currentPlatform()): Record<string, unknown> {
  const valueSchema = (setting: FileSetting) => ({
    description: `${setting.label}. Default: ${JSON.stringify(toFileValue(setting, setting.defaultValue))}.`,
    ...(setting.choices ? { enum: [...setting.choices] } : { type: setting.type }),
    ...(setting.type === 'number' && !setting.choices ? { exclusiveMinimum: 0 } : {}),
  })
  const rebindable = SHORTCUTS.filter((c) => isRebindable(c) && (platform === 'mac' || !c.macOnly))
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Switchboard settings',
    description: 'Only values that differ from the default. Remove a key to go back to its default.',
    type: 'object',
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      settings: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(FILE_SETTINGS.map((s) => [s.key, valueSchema(s)])),
      },
      projects: {
        description: 'Per-project overrides, keyed by the project folder.',
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(
            FILE_SETTINGS.filter((s) => isScopableSetting(s.key)).map((s) => [s.key, valueSchema(s)]),
          ),
        },
      },
      keyboard: {
        description: 'Rebinds, by command id. Keys are written Mod+Shift+Alt+Key (Mod is Cmd on macOS, Ctrl elsewhere); [] unbinds.',
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(rebindable.map((c) => [c.id, {
          description: `${c.label}. Default: ${c.bindings.join(', ')}.`,
          type: 'array',
          items: { type: 'string' },
        }])),
      },
    },
  }
}

/** What the Settings page's banner reports about the file. */
export interface SettingsFileStatus {
  /** Where the file lives, once opened or found at launch. */
  path: string | null
  /** The last save was not valid JSON, so nothing in it was applied. */
  parseError: string | null
  /** Entries the last applied save asked for and did not get. */
  skipped: SkippedEntry[]
  /** A change made in the app was not written, because the file had edits not yet applied. */
  writeSkipped: boolean
  /** A change made in the app could not be written (the file stayed locked, or the write failed); the next change or Open tries again. */
  writeFailed: boolean
}

export const IDLE_SETTINGS_FILE_STATUS: SettingsFileStatus = { path: null, parseError: null, skipped: [], writeSkipped: false, writeFailed: false }

/** The banner's one line, or null when there is nothing to say. */
export function settingsFileBanner(status: SettingsFileStatus): string | null {
  const parts: string[] = []
  if (status.parseError) parts.push(`settings.json was not applied: ${status.parseError}. Fix it and save again.`)
  else if (status.skipped.length > 0) parts.push(`settings.json skipped ${describeSkipped(status.skipped)}.`)
  if (status.writeSkipped) parts.push('A change made here was not written to settings.json, because it has edits that were not applied.')
  else if (status.writeFailed) parts.push('A change made here could not be written to settings.json; the log has the error. The next change or Open tries again.')
  return parts.length > 0 ? parts.join(' ') : null
}

/** Whether a stored settings key is one the file holds, so a write to it should rewrite the file. */
export function isSettingsFileKey(storedKey: string): boolean {
  if (storedKey === KEYBOARD_OVERRIDES_SETTING || BY_KEY.has(storedKey)) return true
  const override = parseProjectOverrideKey(storedKey)
  return !!override && isScopableSetting(override.settingKey)
}
