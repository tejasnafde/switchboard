import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const main = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8')

describe('app quit lifecycle contract', () => {
  it('suppresses macOS activation after teardown starts', () => {
    const activateHandler = main.slice(
      main.indexOf("app.on('activate'"),
      main.indexOf("app.on('window-all-closed'"),
    )

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
})
