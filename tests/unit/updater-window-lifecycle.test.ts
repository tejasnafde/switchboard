import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    updater: {
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) listener(...args)
      },
      removeAllListeners() {
        listeners.clear()
      },
    checkForUpdates: vi.fn(async () => ({})),
    quitAndInstall: vi.fn(),
    autoDownload: false,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
      logger: null as unknown,
    },
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.8.24' },
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    },
  },
}))

vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }))
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

function fakeWindow() {
  return {
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: { send: vi.fn() },
  }
}

describe('updater window lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    mocks.handlers.clear()
    mocks.updater.removeAllListeners()
    mocks.updater.checkForUpdates.mockClear()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('delivers terminal updater state to a replacement window', async () => {
    const { registerAutoUpdater } = await import('../../src/main/updater')
    const first = fakeWindow()
    const replacement = fakeWindow()

    registerAutoUpdater(first as never)
    registerAutoUpdater(replacement as never)
    mocks.updater.emit('update-downloaded', { version: '0.8.25' })

    expect(replacement.webContents.send).toHaveBeenCalledWith(
      'app:update-status',
      { kind: 'downloaded', version: '0.8.25' },
    )
  })

  it('exposes the latest updater state for a settings row that mounted late', async () => {
    const { registerAutoUpdater } = await import('../../src/main/updater')
    registerAutoUpdater(fakeWindow() as never)
    mocks.updater.emit('update-downloaded', { version: '0.8.25' })

    const getStatus = mocks.handlers.get('app:get-update-status')
    expect(getStatus).toBeTypeOf('function')
    expect(await getStatus?.()).toEqual({ kind: 'downloaded', version: '0.8.25' })
  })
})
