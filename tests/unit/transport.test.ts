/**
 * IpcTransport is the in-process renderer↔backend seam. It must forward
 * invoke/send verbatim and, for `on`, strip the IpcRendererEvent arg before
 * calling the handler and return a disposer that removes the same listener.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ipc } = vi.hoisted(() => ({
  ipc: {
    invoke: vi.fn(() => Promise.resolve('RESULT')),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))
vi.mock('electron', () => ({ ipcRenderer: ipc }))

import { IpcTransport } from '../../src/preload/transport'

beforeEach(() => {
  ipc.invoke.mockClear()
  ipc.send.mockClear()
  ipc.on.mockClear()
  ipc.removeListener.mockClear()
})

describe('IpcTransport', () => {
  it('invoke forwards channel + args and resolves the result', async () => {
    const t = new IpcTransport()
    const out = await t.invoke('files:read', '/repo', 'a.ts')
    expect(ipc.invoke).toHaveBeenCalledWith('files:read', '/repo', 'a.ts')
    expect(out).toBe('RESULT')
  })

  it('send forwards channel + args (fire-and-forget)', () => {
    new IpcTransport().send('term:data', { id: '1', data: 'x' })
    expect(ipc.send).toHaveBeenCalledWith('term:data', { id: '1', data: 'x' })
  })

  it('on strips the event arg, forwards the rest, and disposes the same listener', () => {
    const t = new IpcTransport()
    const seen: Array<[string, number]> = []
    const dispose = t.on<[string, number]>('term:exit', (id, code) => seen.push([id, code]))

    expect(ipc.on).toHaveBeenCalledOnce()
    const [channel, wrapped] = ipc.on.mock.calls[0] as [string, (...a: unknown[]) => void]
    expect(channel).toBe('term:exit')

    // Simulate Electron delivering (event, ...args) - the event must be dropped.
    wrapped({ sender: {} }, 'pane-1', 0)
    expect(seen).toEqual([['pane-1', 0]])

    dispose()
    expect(ipc.removeListener).toHaveBeenCalledWith('term:exit', wrapped)
  })
})
