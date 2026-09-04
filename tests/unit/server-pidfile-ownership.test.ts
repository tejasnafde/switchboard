/**
 * Remote server PID ownership.
 *
 * Field evidence this pins down: a stale `node index.cjs` held :8765 for 41h at
 * 99% CPU, and the pidfile pointing at it had been OVERWRITTEN by a later
 * relaunch that failed to bind. Two independent defects made that possible -
 * the pidfile was written at module load (before the bind could fail), and a
 * bind error was only logged, so the failed relaunch never exited. The result:
 * the bootstrap's stale-server kill aimed at a pid that was not the port
 * holder, forever.
 *
 * So the contract is: claim the pidfile only after `listening`, release it only
 * while we still own it, and make any pre-listen bind error a prompt nonzero
 * exit that never touches the file.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  BIND_FAILURE_EXIT_CODE,
  claimPidFile,
  isAddressInUse,
  pidFileOwner,
  releasePidFile,
  type PidFileIo,
} from '../../src/server/pidfile'
import { createBindLifecycle } from '../../src/server/lifecycle'

/** In-memory PidFileIo so ownership logic is testable with no real fs. */
function fakeIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const dirs: string[] = []
  const io: PidFileIo = {
    ensureDir: (dir) => { dirs.push(dir) },
    read: (path) => files.get(path) ?? null,
    write: (path, contents) => { files.set(path, contents) },
    remove: (path) => { files.delete(path) },
  }
  return { io, files, dirs }
}

const PID_FILE = '/home/u/.switchboard-server/server.pid'

describe('pidfile ownership primitives', () => {
  it('claims the file, creating the parent dir', () => {
    const { io, files, dirs } = fakeIo()
    expect(claimPidFile(io, PID_FILE, 4242)).toBe('claimed')
    expect(files.get(PID_FILE)).toBe('4242')
    expect(dirs).toContain('/home/u/.switchboard-server')
  })

  it('reads the recorded owner, tolerating trailing whitespace', () => {
    const { io } = fakeIo({ [PID_FILE]: '1234\n' })
    expect(pidFileOwner(io, PID_FILE)).toBe(1234)
  })

  it('reports no owner for a missing or non-numeric pidfile', () => {
    expect(pidFileOwner(fakeIo().io, PID_FILE)).toBeNull()
    expect(pidFileOwner(fakeIo({ [PID_FILE]: 'not-a-pid' }).io, PID_FILE)).toBeNull()
  })

  it('releases the file only when it still points at us', () => {
    const { io, files } = fakeIo({ [PID_FILE]: '4242' })
    expect(releasePidFile(io, PID_FILE, 4242)).toBe('released')
    expect(files.has(PID_FILE)).toBe(false)
  })

  it('leaves a successor server pidfile alone on our own exit', () => {
    // The 41h incident in reverse: our shutdown must never delete the pidfile
    // of the process that took the port over from us.
    const { io, files } = fakeIo({ [PID_FILE]: '9999' })
    expect(releasePidFile(io, PID_FILE, 4242)).toBe('not-owner')
    expect(files.get(PID_FILE)).toBe('9999')
  })

  it('reports an absent pidfile rather than throwing', () => {
    const { io } = fakeIo()
    expect(releasePidFile(io, PID_FILE, 4242)).toBe('absent')
  })

  it('recognises EADDRINUSE from a node errno object', () => {
    expect(isAddressInUse(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))).toBe(true)
    expect(isAddressInUse(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }))).toBe(false)
    expect(isAddressInUse(null)).toBe(false)
  })
})

describe('server bind lifecycle', () => {
  const deps = (io: PidFileIo, pid = 4242) => {
    const exit = vi.fn()
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    return { lifecycle: createBindLifecycle({ pidFile: PID_FILE, pid, io, exit, log }), exit, log }
  }

  it('does not claim the pidfile before the socket is listening', () => {
    const { io, files } = fakeIo({ [PID_FILE]: '1111' })
    deps(io)
    // Merely constructing the lifecycle (i.e. module load) must not write.
    expect(files.get(PID_FILE)).toBe('1111')
  })

  it('claims the pidfile on listening, replacing a dead predecessor', () => {
    const { io, files } = fakeIo({ [PID_FILE]: '1111' })
    const { lifecycle } = deps(io)
    lifecycle.onListening()
    expect(files.get(PID_FILE)).toBe('4242')
  })

  it('EADDRINUSE exits nonzero promptly and never overwrites the real owner', () => {
    const { io, files } = fakeIo({ [PID_FILE]: '1111' })
    const { lifecycle, exit, log } = deps(io)
    lifecycle.onError(Object.assign(new Error('listen EADDRINUSE 127.0.0.1:8765'), { code: 'EADDRINUSE' }))
    expect(exit).toHaveBeenCalledWith(BIND_FAILURE_EXIT_CODE)
    expect(BIND_FAILURE_EXIT_CODE).toBeGreaterThan(0)
    // The pid of the process actually holding :8765 survives untouched, so the
    // next bootstrap can aim its stale-server kill at the true holder.
    expect(files.get(PID_FILE)).toBe('1111')
    expect(log.error).toHaveBeenCalled()
  })

  it('any pre-listen bind error is fatal, not just EADDRINUSE', () => {
    const { io } = fakeIo()
    const { lifecycle, exit } = deps(io)
    lifecycle.onError(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }))
    expect(exit).toHaveBeenCalledWith(BIND_FAILURE_EXIT_CODE)
  })

  it('exits once even if the socket reports the same bind failure twice', () => {
    const { io } = fakeIo()
    const { lifecycle, exit } = deps(io)
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    lifecycle.onError(err)
    lifecycle.onError(err)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('keeps serving on a post-listen socket error', () => {
    const { io, files } = fakeIo()
    const { lifecycle, exit, log } = deps(io)
    lifecycle.onListening()
    lifecycle.onError(new Error('client socket blew up'))
    expect(exit).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalled()
    expect(files.get(PID_FILE)).toBe('4242')
  })

  it('releases the pidfile on shutdown once it has been claimed', () => {
    const { io, files } = fakeIo()
    const { lifecycle } = deps(io)
    lifecycle.onListening()
    expect(lifecycle.onShutdown('SIGTERM')).toBe('released')
    expect(files.has(PID_FILE)).toBe(false)
  })

  it('a never-listening process cleans up nothing on shutdown', () => {
    // The exact 41h regression: the failed relaunch must not remove (or have
    // written) the pidfile of the process still holding the port.
    const { io, files } = fakeIo({ [PID_FILE]: '1111' })
    const { lifecycle } = deps(io)
    lifecycle.onError(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))
    expect(lifecycle.onShutdown('SIGTERM')).toBe('unclaimed')
    expect(files.get(PID_FILE)).toBe('1111')
  })

  it('does not delete the pidfile a takeover already rewrote', () => {
    const { io, files } = fakeIo()
    const { lifecycle } = deps(io)
    lifecycle.onListening()
    io.write(PID_FILE, '9999') // a successor claimed the port
    expect(lifecycle.onShutdown('SIGTERM')).toBe('not-owner')
    expect(files.get(PID_FILE)).toBe('9999')
  })

  it('onShutdown is idempotent: a second call repeats the first outcome instead of re-checking ownership', () => {
    // A repeat SIGTERM, or a normal-completion callback racing the force-exit
    // watchdog's own call, must not re-run the release decision - if a
    // takeover rewrote the file between the two calls, a naive second check
    // would see 'not-owner' and skip nothing new, but a naive second RELEASE
    // attempt on a since-absent file is the more dangerous shape: it must not
    // silently look like something changed.
    const { io, files } = fakeIo()
    const { lifecycle } = deps(io)
    lifecycle.onListening()
    expect(lifecycle.onShutdown('SIGTERM')).toBe('released')
    expect(files.has(PID_FILE)).toBe(false)
    // A successor claims the now-empty file after our first shutdown call.
    io.write(PID_FILE, '9999')
    expect(lifecycle.onShutdown('SIGTERM')).toBe('released')
    // The cached outcome from the FIRST call, not a fresh (and wrong) check
    // against the successor's pid - which must survive untouched.
    expect(files.get(PID_FILE)).toBe('9999')
  })
})
