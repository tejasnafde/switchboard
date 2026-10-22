import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const logged = vi.hoisted(() => [] as Array<{ msg: string; fields: unknown }>)
vi.mock('../../src/main/logger', () => {
  const record = (msg: string, fields: unknown) => logged.push({ msg, fields })
  return { createMainLogger: () => ({ debug: record, info: record, warn: record, error: record }) }
})

import {
  attachRendererCrashRecovery,
  createReloadLimiter,
  CRASH_RELOAD_URL,
} from '../../src/main/renderer-crash-recovery'

function fakeWindow() {
  let url = 'file:///app/index.html'
  const contents = Object.assign(new EventEmitter(), {
    reload: vi.fn(),
    loadURL: vi.fn(async (next: string) => {
      url = next
    }),
    getURL: () => url,
  })
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const gone = (reason: string) => contents.emit('render-process-gone', {}, { reason, exitCode: 1 })
  return { window, contents, gone }
}

describe('createReloadLimiter', () => {
  it('allows 3 reloads per minute, then refuses until the oldest leaves the window', () => {
    let t = 0
    const allow = createReloadLimiter(() => t)
    const at = (ms: number) => {
      t = ms
      return allow()
    }
    expect([at(0), at(10_000), at(20_000), at(30_000)]).toEqual([true, true, true, false])
    t = 59_999
    expect(allow()).toBe(false)
    t = 60_000
    expect(allow()).toBe(true)
    expect(allow()).toBe(false)
  })
})

describe('attachRendererCrashRecovery', () => {
  it.each(['crashed', 'oom', 'abnormal-exit', 'killed'])('reloads on %s and logs the reason', (reason) => {
    logged.length = 0
    const { window, contents, gone } = fakeWindow()
    attachRendererCrashRecovery(window, vi.fn())
    gone(reason)
    expect(contents.reload).toHaveBeenCalledTimes(1)
    expect(logged).toEqual([{ msg: 'renderer gone, reloading', fields: { reason, exitCode: 1 } }])
  })

  it.each(['clean-exit', 'launch-failed', 'integrity-failure'])('does not reload on %s but still logs it', (reason) => {
    logged.length = 0
    const { window, contents, gone } = fakeWindow()
    attachRendererCrashRecovery(window, vi.fn())
    gone(reason)
    expect(contents.reload).not.toHaveBeenCalled()
    expect(contents.loadURL).not.toHaveBeenCalled()
    expect(logged).toEqual([{ msg: 'renderer gone, no reload', fields: { reason, exitCode: 1 } }])
  })

  it('shows the error page on the 4th crash in a minute, and its Reload button reloads the app', () => {
    const { window, contents, gone } = fakeWindow()
    const load = vi.fn()
    attachRendererCrashRecovery(window, load, () => 0)
    for (let i = 0; i < 4; i++) gone('crashed')
    expect(contents.reload).toHaveBeenCalledTimes(3)
    expect(contents.loadURL).toHaveBeenCalledTimes(1)
    const page = decodeURIComponent(String(contents.loadURL.mock.calls[0][0]))
    expect(page).toMatch(/^data:text\/html/)
    expect(page).toContain(CRASH_RELOAD_URL)

    const event = { preventDefault: vi.fn() }
    contents.emit('will-navigate', event, CRASH_RELOAD_URL)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('counts each window separately', () => {
    const a = fakeWindow()
    const b = fakeWindow()
    attachRendererCrashRecovery(a.window, vi.fn(), () => 0)
    attachRendererCrashRecovery(b.window, vi.fn(), () => 0)
    for (let i = 0; i < 3; i++) a.gone('oom')
    b.gone('oom')
    expect(b.contents.reload).toHaveBeenCalledTimes(1)
    expect(b.contents.loadURL).not.toHaveBeenCalled()
  })

  it('does not reload from a link to the sentinel inside the app', () => {
    const { window, contents } = fakeWindow()
    const load = vi.fn()
    attachRendererCrashRecovery(window, load)
    contents.emit('will-navigate', { preventDefault: vi.fn() }, CRASH_RELOAD_URL)
    expect(load).not.toHaveBeenCalled()
  })

  it('does nothing for a destroyed window', () => {
    const { contents, gone } = fakeWindow()
    const window = { webContents: contents, isDestroyed: () => true } as unknown as BrowserWindow
    attachRendererCrashRecovery(window, vi.fn())
    gone('crashed')
    expect(contents.reload).not.toHaveBeenCalled()
    expect(contents.loadURL).not.toHaveBeenCalled()
  })

  it('leaves other navigations alone', () => {
    const { window, contents } = fakeWindow()
    const load = vi.fn()
    attachRendererCrashRecovery(window, load)
    const event = { preventDefault: vi.fn() }
    contents.emit('will-navigate', event, 'https://example.com/')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  })

  it('does not reload a renderer killed during a quit', () => {
    const { window, contents, gone } = fakeWindow()
    attachRendererCrashRecovery(
      window,
      vi.fn(),
      () => 0,
      () => true,
    )
    gone('killed')
    expect(contents.reload).not.toHaveBeenCalled()
  })
})
