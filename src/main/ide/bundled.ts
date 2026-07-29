/**
 * Locating the sb-bridge extension that ships inside the app (electron-builder
 * `extraResources`). Two consumers, two shapes:
 *
 * - the LOCAL workbench copies the directory straight across (seedBridgeExtension)
 * - a REMOTE workbench has no access to this filesystem, so the provisioner
 *   ships the files base64'd over ssh (bridgeSeedScript)
 *
 * Kept out of ipc/ide.ts so machines/ can reach it without pulling in the whole
 * code-server lifecycle.
 */
import { app } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { BridgeFile } from '../machines/provisionSetup'
import { createMainLogger } from '../logger'

const log = createMainLogger('ide:bundled')

export function bundledExtensionDir(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'sb-bridge'),
    join(app.getAppPath(), 'resources', 'sb-bridge'),
  ]
  const found = candidates.find((p) => p && existsSync(p))
  if (!found) throw new Error(`sb-bridge extension not found in: ${candidates.join(', ')}`)
  return found
}

/**
 * Every bundled sb-bridge file, base64'd, for shipping to a remote. Returns []
 * rather than throwing when the extension is missing - provisioning must still
 * deliver a working backend on a build without it, so the caller degrades to a
 * bridge-less workbench and logs why.
 */
export function bundledBridgeFiles(): BridgeFile[] {
  try {
    const root = bundledExtensionDir()
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const abs = join(entry.parentPath, entry.name)
        // POSIX separators: relPath is interpolated into a remote shell path.
        return { relPath: relative(root, abs).split(sep).join('/'), base64: readFileSync(abs).toString('base64') }
      })
  } catch (err) {
    log.warn('could not read bundled sb-bridge extension', err)
    return []
  }
}
