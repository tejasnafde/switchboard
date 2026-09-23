import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
const { readLaunchConfig, writeLaunchConfig } = await import('../../src/main/launch-config/launch-config-store')

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-launch-legacy-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.switchboard'))
  return dir
}

describe('legacy workspace.yaml', () => {
  it('is read when it is the only config a project has', () => {
    const dir = project()
    writeFileSync(join(dir, '.switchboard', 'workspace.yaml'), 'legacy: true\n')
    expect(readLaunchConfig(dir)).toBe('legacy: true\n')
  })

  it('loses to launch-config.yaml when both exist', () => {
    const dir = project()
    writeFileSync(join(dir, '.switchboard', 'workspace.yaml'), 'legacy: true\n')
    writeFileSync(join(dir, '.switchboard', 'launch-config.yaml'), 'current: true\n')
    expect(readLaunchConfig(dir)).toBe('current: true\n')
  })

  it('is migrated by the next save, which writes the new name', () => {
    const dir = project()
    writeFileSync(join(dir, '.switchboard', 'workspace.yaml'), 'legacy: true\n')
    writeLaunchConfig(dir, 'saved: true\n')
    expect(existsSync(join(dir, '.switchboard', 'launch-config.yaml'))).toBe(true)
    expect(readFileSync(join(dir, '.switchboard', 'launch-config.yaml'), 'utf8')).toBe('saved: true\n')
    expect(readLaunchConfig(dir)).toBe('saved: true\n')
  })
})

describe('launch config watcher', () => {
  it('survives its project folder being deleted', async () => {
    const dir = project()
    writeFileSync(join(dir, '.switchboard', 'launch-config.yaml'), 'a: 1\n')
    readLaunchConfig(dir)
    rmSync(dir, { recursive: true, force: true })
    // An unhandled watcher 'error' would fail the run here (EPERM on Windows).
    await new Promise((r) => setTimeout(r, 50))
    expect(readLaunchConfig(dir)).toBeNull()
  })
})
