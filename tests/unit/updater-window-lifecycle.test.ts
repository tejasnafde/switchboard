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
  powerMonitor: { on: vi.fn(), off: vi.fn() },
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

  it('a manual check reuses a real check already stuck, instead of starting a second one', async () => {
    // Never resolves - simulates the stalled-connect case the CHECK_TIMEOUT_MS
    // backstop exists for (a healthy check takes ~2s; a stalled one measured
    // ~77s, see the comment on CHECK_TIMEOUT_MS in updater.ts).
    mocks.updater.checkForUpdates.mockImplementation(() => new Promise(() => {}))

    const { registerAutoUpdater } = await import('../../src/main/updater')
    registerAutoUpdater(fakeWindow() as never)

    // Let the initial launch-time check fire and make the one real request.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1)

    // A manual check while that request is still stuck must not start a
    // second real request - it shares the one already running.
    const manualCheck = mocks.handlers.get('app:check-for-updates')
    const manualResult = manualCheck?.()
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1)

    // Each caller still gets its own timeout: both the initial check's and
    // this manual check's client-side wait give up, even though the shared
    // real request underneath never settles.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await manualResult).toEqual({
      kind: 'slow',
      message: expect.stringContaining('slow'),
    })
    // Still exactly one real request - the timeout is a client-side give up,
    // not a cancellation, so there is nothing to retry yet.
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('an hourly check waits for a download the launch check started', async () => {
    let finishDownload: (paths: string[]) => void = () => {}
    const downloadPromise = new Promise<string[]>((resolve) => { finishDownload = resolve })
    mocks.updater.checkForUpdates.mockImplementation(async () => ({ downloadPromise }))

    const { registerAutoUpdater } = await import('../../src/main/updater')
    registerAutoUpdater(fakeWindow() as never)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1)

    // The check has settled but its download has not: the hourly tick skips.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1)

    // Once the download settles (here without an update-downloaded event),
    // the next tick checks again.
    finishDownload([])
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})
