import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, watch, type FSWatcher } from 'fs'
import { createMainLogger as createLogger } from '../logger'

const log = createLogger('launch-config')

// Push to the renderer via whichever host is wired (ElectronIpcHost or WsHost),
// set once at handler registration. No-op until then.
type LaunchConfigEmitter = (channel: string, ...args: unknown[]) => void
let emit: LaunchConfigEmitter = () => {}
export function setLaunchConfigEmitter(fn: LaunchConfigEmitter): void {
  emit = fn
}

// Current filename. New projects (and any save) use this.
function configPath(projectPath: string): string {
  return join(projectPath, '.switchboard', 'launch-config.yaml')
}

// Pre-rename filename. Read-only fallback so existing projects keep
// working until their config is next saved (which writes the new name).
function legacyConfigPath(projectPath: string): string {
  return join(projectPath, '.switchboard', 'workspace.yaml')
}

/**
 * The path we should read from: the new file if present, otherwise the
 * legacy `workspace.yaml` if that's all a project has. Returns the new
 * path when neither exists (callers null-check existence separately).
 */
function readPath(projectPath: string): string {
  const current = configPath(projectPath)
  if (existsSync(current)) return current
  const legacy = legacyConfigPath(projectPath)
  if (existsSync(legacy)) return legacy
  return current
}

const watchers = new Map<string, FSWatcher>()

/**
 * Watch a project's launch config for changes and emit an IPC event.
 * Watches whichever file currently backs the project (new or legacy).
 */
export function watchLaunchConfig(projectPath: string): void {
  if (watchers.has(projectPath)) return

  const path = readPath(projectPath)
  if (!existsSync(path)) return

  try {
    const watcher = watch(path, (eventType) => {
      if (eventType === 'change') {
        log.info(`launch config changed for ${projectPath}, notifying renderer...`)
        emit('app:launch-config-changed', projectPath)
      }
    })
    watchers.set(projectPath, watcher)
    log.info(`watching launch config for ${projectPath}`)
  } catch (err) {
    log.warn(`failed to watch launch config: ${path}`, err)
  }
}

/**
 * Read a project's launch config. Returns raw YAML string or null.
 * Prefers `launch-config.yaml`, falling back to the legacy
 * `workspace.yaml` for projects written before the rename.
 */
export function readLaunchConfig(projectPath: string): string | null {
  const path = readPath(projectPath)
  watchLaunchConfig(projectPath) // Ensure we're watching it if it's read
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    log.warn(`failed to read launch config: ${path}`, err)
    return null
  }
}

/**
 * Write a project's launch config. Always writes the current
 * `launch-config.yaml` filename.
 */
export function writeLaunchConfig(projectPath: string, yamlContent: string): void {
  const path = configPath(projectPath)
  try {
    const dir = join(projectPath, '.switchboard')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(path, yamlContent, 'utf-8')
    log.info(`launch config saved: ${path}`)
  } catch (err) {
    log.error(`failed to write launch config: ${path}`, err)
    throw err
  }
}
