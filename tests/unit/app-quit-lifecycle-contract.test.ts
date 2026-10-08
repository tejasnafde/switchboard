import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const main = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8')

describe('app quit lifecycle contract', () => {
  it('suppresses macOS activation after teardown starts', () => {
    const activateHandler = main.slice(main.indexOf("app.on('activate'"), main.indexOf("app.on('window-all-closed'"))

    expect(activateHandler).toContain('quitCoordinator.isQuitting')
    expect(activateHandler.indexOf('quitCoordinator.isQuitting')).toBeLessThan(
      activateHandler.indexOf('createWindow()'),
    )
  })

  it('suppresses second-instance and deep-link focus after teardown starts', () => {
    const openUrlHandler = main.slice(main.indexOf("app.on('open-url'"), main.indexOf('// Single instance lock'))
    const secondInstanceHandler = main.slice(
      main.indexOf("app.on('second-instance'"),
      main.indexOf('interface SavedBounds'),
    )

    expect(openUrlHandler).toContain('quitCoordinator.isQuitting')
    expect(secondInstanceHandler).toContain('quitCoordinator.isQuitting')
    expect(secondInstanceHandler.indexOf('quitCoordinator.isQuitting')).toBeLessThan(
      secondInstanceHandler.indexOf('mainWindow.isDestroyed()'),
    )
  })

  it('closes every writer and watcher before the database, which closes last and for good', () => {
    const teardown = main.slice(main.search(/runShutdownSequence\(\s*\[/), main.indexOf('{ log: shutdownLog }'))
    const order = [...teardown.matchAll(/name: '([a-z-]+)'/g)].map((m) => m[1])
    expect(order[0]).toBe('window-bounds')
    expect(order.at(-1)).toBe('database')
    for (const step of [
      'terminals',
      'providers',
      'switchboard-mcp',
      'ide',
      'machines',
      'mobile-endpoint',
      'file-watchers',
    ]) {
      expect(order).toContain(step)
    }
    expect(order.indexOf('terminals')).toBeLessThan(order.indexOf('providers'))
    expect(teardown).toContain('closeDb({ forQuit: true })')
    expect(teardown).toContain('disposeSettingsFileSync()')
    expect(teardown).toContain('closeAllLaunchConfigWatchers()')
    expect(teardown).toContain('closeAllHeadWatchers()')
  })

  it('does not write window bounds from the close event once quit has started', () => {
    const closeHandler = main.slice(main.indexOf("window.on('close'"), main.indexOf("window.on('close'") + 120)
    expect(closeHandler).toContain('!quitCoordinator.isQuitting')
  })
})
