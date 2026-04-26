import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { createMainLogger as createLogger } from '../logger'

const log = createLogger('workspace')

function getWorkspacesDir(): string {
  const dir = join(app.getPath('userData'), 'workspaces')
  mkdirSync(dir, { recursive: true })
  return dir
}

function hashPath(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
}

function configPath(projectPath: string): string {
  return join(getWorkspacesDir(), `${hashPath(projectPath)}.yaml`)
}

/**
 * Read workspace.yaml for a project. Returns raw YAML string or null.
 */
export function readWorkspaceConfig(projectPath: string): string | null {
  const path = configPath(projectPath)
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
    writeFileSync(path, yamlContent, 'utf-8')
    log.info(`workspace config saved: ${path}`)
  } catch (err) {
    log.error(`failed to write workspace config: ${path}`, err)
    throw err
  }
}
