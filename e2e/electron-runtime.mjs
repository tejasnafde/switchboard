import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const NATIVE_MODULES = new Set(['better-sqlite3', 'node-pty'])
const ISOLATED_MODULES = new Set([...NATIVE_MODULES, 'node-addon-api'])

function linkDependency(source, destination, directory) {
  symlinkSync(source, destination, process.platform === 'win32' && directory ? 'junction' : undefined)
}

function defaultRebuild(repoRoot) {
  return async (moduleDir) => {
    execFileSync(
      join(repoRoot, 'node_modules', '.bin', 'electron-rebuild'),
      ['--force', '--which-module', [...NATIVE_MODULES].join(','), '--module-dir', dirname(moduleDir)],
      { cwd: repoRoot, stdio: 'inherit' },
    )
  }
}

export async function prepareElectronTestRuntime({
  repoRoot,
  tempRoot = tmpdir(),
  rebuild = defaultRebuild(repoRoot),
}) {
  const appPath = mkdtempSync(join(tempRoot, 'sb-e2e-runtime-'))
  const cleanup = () => rmSync(appPath, { recursive: true, force: true })
  try {
    cpSync(join(repoRoot, 'package.json'), join(appPath, 'package.json'))
    cpSync(join(repoRoot, 'out'), join(appPath, 'out'), { recursive: true })
    for (const asset of ['resources', 'videos']) {
      const source = join(repoRoot, asset)
      if (existsSync(source)) linkDependency(source, join(appPath, asset), true)
    }

    const sourceModules = join(repoRoot, 'node_modules')
    const runtimeModules = join(appPath, 'node_modules')
    mkdirSync(runtimeModules)
    for (const entry of readdirSync(sourceModules, { withFileTypes: true })) {
      const source = join(sourceModules, entry.name)
      const destination = join(runtimeModules, basename(entry.name))
      if (ISOLATED_MODULES.has(entry.name)) {
        // Worktrees commonly symlink node_modules to another checkout. Native
        // addons must still become real, isolated copies before rebuilding or
        // electron-rebuild would mutate the checkout that owns the symlink.
        cpSync(source, destination, { recursive: true, dereference: true })
      } else {
        linkDependency(source, destination, entry.isDirectory())
      }
    }

    await rebuild(runtimeModules)
    return { appPath, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
