import { describe, expect, it, vi } from 'vitest'
import { DevServerWatch, extractDevServers, stripAnsi } from '../../src/main/terminal/dev-server-watch'

const spawn = vi.fn()
vi.mock('node-pty', () => ({ spawn }))

describe('extractDevServers', () => {
  it('reads the common dev runner banners', () => {
    expect(extractDevServers('  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose')).toEqual([
      'localhost:5173',
    ])
    expect(extractDevServers('   - Local:        http://localhost:3000\n')).toEqual(['localhost:3000'])
    expect(extractDevServers('Listening on port 8080\n')).toEqual(['localhost:8080'])
    expect(extractDevServers('Server running at http://127.0.0.1:4000 and https://0.0.0.0:8443/x')).toEqual([
      'localhost:4000',
      'https://localhost:8443',
    ])
    expect(extractDevServers('serving on http://[::1]:9000/ and http://[::]:9001/')).toEqual([
      'localhost:9000',
      'localhost:9001',
    ])
  })

  it('ignores non-loopback hosts, bad ports and plain text', () => {
    expect(extractDevServers('Network: http://192.168.1.4:5173/')).toEqual([])
    expect(extractDevServers('http://localhost:99999 http://localhost:0')).toEqual([])
    expect(extractDevServers('import x from "y"; export default 3000')).toEqual([])
  })

  it('strips ANSI colour and OSC sequences before matching', () => {
    const vite = '\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n'
    expect(stripAnsi(vite)).toBe('➜  Local:   http://localhost:5173/\n')
    expect(extractDevServers(vite)).toEqual(['localhost:5173'])
    expect(extractDevServers('\x1b]0;title\x07http://localhost:3000\n')).toEqual(['localhost:3000'])
  })
})

describe('DevServerWatch', () => {
  it('reads an address split across two chunks once, whole', () => {
    const watch = new DevServerWatch()
    watch.observe('p1', '/repo', 'Local: http://localhost:51')
    watch.observe('p1', '/repo', '73/\n')
    expect(watch.serversFor('/repo')).toEqual(['localhost:5173'])
  })

  it('keeps the newest three per terminal', () => {
    const watch = new DevServerWatch()
    for (const port of [3000, 3001, 3002, 3003]) watch.observe('p1', '/repo', `http://localhost:${port}/\n`)
    watch.observe('p1', '/repo', 'http://localhost:3001/\n')
    expect(watch.serversFor('/repo')).toEqual(['localhost:3001', 'localhost:3003', 'localhost:3002'])
  })

  it('does not count output already read again', () => {
    const watch = new DevServerWatch()
    watch.observe('p1', '/repo', 'http://localhost:3000/\n')
    watch.observe('p1', '/repo', 'http://localhost:4000/\n')
    watch.observe('p1', '/repo', 'ok\n')
    expect(watch.serversFor('/repo')).toEqual(['localhost:4000', 'localhost:3000'])
  })

  it('matches a terminal in the project folder or under it, not a sibling or a parent', () => {
    const watch = new DevServerWatch()
    watch.observe('root', '/work/app', 'http://localhost:1000/\n')
    watch.observe('sub', '/work/app/web', 'http://localhost:2000/\n')
    watch.observe('sibling', '/work/app-two', 'http://localhost:3000/\n')
    watch.observe('parent', '/work', 'http://localhost:4000/\n')
    expect(watch.serversFor('/work/app')).toEqual(['localhost:2000', 'localhost:1000'])
    expect(watch.serversFor('/work/app/')).toEqual(['localhost:2000', 'localhost:1000'])
    expect(watch.serversFor('/work/app/web')).toEqual(['localhost:2000'])
    expect(watch.serversFor(undefined)).toEqual([])
  })

  it('forgets a terminal', () => {
    const watch = new DevServerWatch()
    watch.observe('p1', '/repo', 'http://localhost:3000/\n')
    watch.forget('p1')
    expect(watch.serversFor('/repo')).toEqual([])
  })
})

describe('PtyManager feeds the watch', () => {
  it('records output by cwd and forgets it on exit and on kill', async () => {
    const ptys: Array<{ data: (v: string) => void; exit: (v: { exitCode: number }) => void }> = []
    spawn.mockImplementation(() => {
      const callbacks = { data: (_v: string) => {}, exit: (_v: { exitCode: number }) => {} }
      ptys.push(callbacks)
      return {
        onData: (cb: (v: string) => void) => (callbacks.data = cb),
        onExit: (cb: (v: { exitCode: number }) => void) => (callbacks.exit = cb),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      }
    })
    const { PtyManager } = await import('../../src/main/terminal/pty-manager')
    const watch = new DevServerWatch()
    const manager = new PtyManager(vi.fn(), vi.fn(), watch)

    await manager.create({ id: 'a', cwd: '/repo' })
    await manager.create({ id: 'b', cwd: '/repo/web' })
    ptys[0].data('Local: http://localhost:5173/\n')
    ptys[1].data('Listening on port 8080\n')
    expect(watch.serversFor('/repo')).toEqual(['localhost:8080', 'localhost:5173'])

    ptys[0].exit({ exitCode: 0 })
    expect(watch.serversFor('/repo')).toEqual(['localhost:8080'])
    manager.kill('b')
    expect(watch.serversFor('/repo')).toEqual([])
  })
})
