import { beforeEach, describe, expect, it, vi } from 'vitest'

const { send, breadcrumb, error } = vi.hoisted(() => ({
  send: vi.fn(),
  breadcrumb: vi.fn(),
  error: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
  },
}))

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error }),
  writeCrashBreadcrumb: breadcrumb,
}))

import { ElectronIpcHost } from '../../src/main/backend/host'

describe('ElectronIpcHost emit safety', () => {
  beforeEach(() => {
    send.mockReset()
    breadcrumb.mockReset()
    error.mockReset()
  })

  it('sends only JSON-normalized arguments and records risky event metadata', () => {
    const host = new ElectronIpcHost({
      isDestroyed: () => false,
      webContents: { send },
    } as never)

    host.emit('provider:event', {
      type: 'tool.completed',
      threadId: 'thread-1',
      toolId: 'tool-1',
      output: 'done',
      at: new Date('2026-08-19T17:17:20.000Z'),
    })

    expect(send).toHaveBeenCalledWith('provider:event', {
      type: 'tool.completed',
      threadId: 'thread-1',
      toolId: 'tool-1',
      output: 'done',
      at: '2026-08-19T17:17:20.000Z',
    })
    expect(breadcrumb).toHaveBeenCalledWith('backend:electron-ipc', expect.objectContaining({
      action: 'send',
      channel: 'provider:event',
      eventType: 'tool.completed',
      threadId: 'thread-1',
      eventId: 'tool-1',
      bytes: expect.any(Number),
    }))
  })

  it('drops a non-JSON payload before webContents.send', () => {
    const host = new ElectronIpcHost({
      isDestroyed: () => false,
      webContents: { send },
    } as never)

    host.emit('provider:event', {
      type: 'tool.completed',
      threadId: 'thread-1',
      output: 1n,
    })

    expect(send).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('dropped unsafe IPC emit', expect.objectContaining({ ok: false }))
    expect(breadcrumb).toHaveBeenCalledWith('backend:electron-ipc', expect.objectContaining({
      action: 'dropped',
      eventType: 'tool.completed',
      threadId: 'thread-1',
    }))
  })
})
