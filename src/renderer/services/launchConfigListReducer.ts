/**
 * Pure reducer for the Settings → Launch Configs list editor.
 *
 * Drives add / rename / delete / replace-body actions on a parsed
 * `LaunchConfigFile`. The Settings UI calls this on every action and
 * persists the resulting config back to disk via
 * `serializeLaunchConfigFile`.
 *
 * Invariants:
 *   - `default` is the implicit fallback for new chats; it cannot be
 *     deleted, cannot be renamed away, and other configs cannot be
 *     renamed *onto* it (would silently destroy whatever was there).
 *   - All actions return `{ ok: false, error }` on rejection rather
 *     than throwing - the UI surfaces `error` inline.
 *   - The reducer is pure: callers receive a fresh config and decide
 *     when to persist.
 *
 * Backed by `tests/unit/launch-config-reducer.test.ts`.
 */
import type { LaunchConfigFile, LaunchConfig } from '../../shared/launch-config'

export type LaunchConfigListAction =
  | { type: 'addLaunchConfig'; name: string }
  | { type: 'deleteLaunchConfig'; name: string }
  | { type: 'renameLaunchConfig'; from: string; to: string }
  | { type: 'replaceLaunchConfigBody'; name: string; body: LaunchConfig }

export type LaunchConfigListResult =
  | { ok: true; config: LaunchConfigFile }
  | { ok: false; error: string }

const RESERVED = 'default'

export function launchConfigListReducer(
  config: LaunchConfigFile,
  action: LaunchConfigListAction,
): LaunchConfigListResult {
  const configs = { ...(config.configs ?? {}) }

  switch (action.type) {
    case 'addLaunchConfig': {
      const name = action.name.trim()
      if (!name) return { ok: false, error: 'Launch config name is required.' }
      if (configs[name]) return { ok: false, error: `Launch config "${name}" already exists.` }
      configs[name] = { terminals: [{ label: 'Terminal 1' }] }
      return { ok: true, config: withLaunchConfigs(config, configs) }
    }

    case 'deleteLaunchConfig': {
      if (action.name === RESERVED) {
        return { ok: false, error: 'The "default" launch config cannot be deleted.' }
      }
      if (!configs[action.name]) {
        return { ok: false, error: `Launch config "${action.name}" does not exist.` }
      }
      delete configs[action.name]
      return { ok: true, config: withLaunchConfigs(config, configs) }
    }

    case 'renameLaunchConfig': {
      const from = action.from
      const to = action.to.trim()
      if (from === to) return { ok: true, config }
      if (!to) return { ok: false, error: 'New name is required.' }
      if (from === RESERVED) {
        return { ok: false, error: 'The "default" launch config cannot be renamed.' }
      }
      if (!configs[from]) {
        return { ok: false, error: `Launch config "${from}" does not exist.` }
      }
      if (configs[to]) {
        return { ok: false, error: `Launch config "${to}" already exists.` }
      }
      configs[to] = configs[from]
      delete configs[from]
      return { ok: true, config: withLaunchConfigs(config, configs) }
    }

    case 'replaceLaunchConfigBody': {
      if (!configs[action.name]) {
        return { ok: false, error: `Launch config "${action.name}" does not exist.` }
      }
      configs[action.name] = action.body
      return { ok: true, config: withLaunchConfigs(config, configs) }
    }
  }
}

/**
 * Re-derive the `terminals` / `rows` mirror fields from `configs.default`
 * so legacy callers that read `config.terminals` directly stay consistent
 * with the modern configs map.
 */
function withLaunchConfigs(
  config: LaunchConfigFile,
  configs: Record<string, LaunchConfig>,
): LaunchConfigFile {
  const def = configs[RESERVED]
  return {
    ...config,
    configs,
    terminals: def?.terminals ?? [],
    rows: def?.rows,
  }
}
