import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, watch, type FSWatcher } from 'fs'
import { BrowserWindow } from 'electron'
import { createMainLogger as createLogger } from '../logger'

const log = createLogger('workspace')

function configPath(projectPath: string): string {
  return join(projectPath, '.switchboard', 'workspace.yaml')
}

const watchers = new Map<string, FSWatcher>()

/**
 * Watch a project's workspace.yaml for changes and emit an IPC event.
 */
export function watchWorkspaceConfig(projectPath: string): void {
  if (watchers.has(projectPath)) return
  
  const path = configPath(projectPath)
  if (!existsSync(path)) return

  try {
    const watcher = watch(path, (eventType) => {
      if (eventType === 'change') {
        log.info(`workspace.yaml changed for ${projectPath}, notifying renderer...`)
        const window = BrowserWindow.getAllWindows()[0]
        if (window && !window.isDestroyed()) {
          window.webContents.send('app:workspace-changed', projectPath)
        }
      }
    })
    watchers.set(projectPath, watcher)
    log.info(`watching workspace.yaml for ${projectPath}`)
  } catch (err) {
    log.warn(`failed to watch workspace config: ${path}`, err)
  }
}

/**
 * Read workspace.yaml for a project. Returns raw YAML string or null.
 */
export function readWorkspaceConfig(projectPath: string): string | null {
  const path = configPath(projectPath)
  watchWorkspaceConfig(projectPath) // Ensure we're watching it if it's read
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    log.warn(`failed to read workspace config: ${path}`, err)
    return null
  }
}

/**
 * Write workspace.yaml for a project.
 */
export function writeWorkspaceConfig(projectPath: string, yamlContent: string): void {
  const path = configPath(projectPath)
  try {
    const dir = join(projectPath, '.switchboard')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(path, yamlContent, 'utf-8')
    log.info(`workspace config saved: ${path}`)
  } catch (err) {
    log.error(`failed to write workspace config: ${path}`, err)
    throw err
  }
}
