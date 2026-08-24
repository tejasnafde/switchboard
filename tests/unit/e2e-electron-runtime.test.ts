import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Electron E2E runtime isolation', () => {
  it('copies native modules for Electron rebuilding without mutating the Node test install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-electron-runtime-test-'))
    roots.push(root)
    const repoRoot = join(root, 'repo')
    const tempRoot = join(root, 'tmp')
    mkdirSync(join(repoRoot, 'out', 'main'), { recursive: true })
    mkdirSync(join(repoRoot, 'real-native', 'better-sqlite3'), { recursive: true })
    mkdirSync(join(repoRoot, 'node_modules'), { recursive: true })
    symlinkSync(join(repoRoot, 'real-native', 'better-sqlite3'), join(repoRoot, 'node_modules', 'better-sqlite3'))
    mkdirSync(join(repoRoot, 'node_modules', 'node-pty'), { recursive: true })
    mkdirSync(join(repoRoot, 'node_modules', 'ordinary-package'), { recursive: true })
    mkdirSync(tempRoot)
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'switchboard-fixture', main: 'out/main/index.js' }))
    writeFileSync(join(repoRoot, 'out', 'main', 'index.js'), 'fixture')
    writeFileSync(join(repoRoot, 'real-native', 'better-sqlite3', 'binding.node'), 'node-abi')
    writeFileSync(join(repoRoot, 'node_modules', 'node-pty', 'pty.node'), 'node-abi')
    writeFileSync(join(repoRoot, 'node_modules', 'ordinary-package', 'index.js'), 'ordinary')
    const rebuild = vi.fn(async (moduleDir: string) => {
      writeFileSync(join(moduleDir, 'better-sqlite3', 'binding.node'), 'electron-abi')
    })

    const { prepareElectronTestRuntime } = await import('../../e2e/electron-runtime.mjs')
    const runtime = await prepareElectronTestRuntime({ repoRoot, tempRoot, rebuild })

    expect(rebuild).toHaveBeenCalledOnce()
    expect(rebuild).toHaveBeenCalledWith(join(runtime.appPath, 'node_modules'))
    expect(lstatSync(join(runtime.appPath, 'node_modules', 'better-sqlite3')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(runtime.appPath, 'node_modules', 'node-pty')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(runtime.appPath, 'node_modules', 'ordinary-package')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(runtime.appPath, 'node_modules', 'better-sqlite3', 'binding.node'), 'utf8')).toBe('electron-abi')
    expect(readFileSync(join(repoRoot, 'real-native', 'better-sqlite3', 'binding.node'), 'utf8')).toBe('node-abi')
    expect(existsSync(join(runtime.appPath, 'out', 'main', 'index.js'))).toBe(true)

    runtime.cleanup()
    expect(existsSync(runtime.appPath)).toBe(false)
  })
})
