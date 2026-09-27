import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, shell: {} }))

import { closeAllLaunchConfigWatchers, watchLaunchConfig } from '../../src/main/launch-config/launch-config-store'
import { closeAllHeadWatchers } from '../../src/main/git/head-watcher'
import { disposeSettingsFileSync, settingsFileSync } from '../../src/main/ipc/settings-file'

const root = mkdtempSync(join(tmpdir(), 'sb-quit-watchers-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('quit-time watcher closes', () => {
  it('closes launch-config watchers, and a second close is a no-op', () => {
    const project = join(root, 'p')
    mkdirSync(join(project, '.switchboard'), { recursive: true })
    writeFileSync(join(project, '.switchboard', 'launch-config.yaml'), 'windows: []\n')
    watchLaunchConfig(project)
    expect(() => closeAllLaunchConfigWatchers()).not.toThrow()
    expect(() => closeAllLaunchConfigWatchers()).not.toThrow()
  })

  it('closes head watchers idempotently', () => {
    expect(() => { closeAllHeadWatchers(); closeAllHeadWatchers() }).not.toThrow()
  })

  it('disposes settings.json sync idempotently', () => {
    disposeSettingsFileSync()
    disposeSettingsFileSync()
    expect(settingsFileSync()).toBeNull()
  })
})
