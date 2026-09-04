/**
 * Bind lifecycle for the headless backend's WebSocket listener.
 *
 * One state machine over three events, so the ordering rules that the 41h
 * stale-server incident violated are stated once and tested once:
 *
 *   listening -> claim the pidfile (we are now the port's owner)
 *   error before listening -> FATAL: log, exit nonzero, touch nothing
 *   error after listening -> log, keep serving
 *   shutdown -> release the pidfile only if we claimed it and still own it
 *
 * The "touch nothing" clause is the important one: a relaunch racing the real
 * owner must leave that owner's pid intact, because the remote bootstrap kills
 * by pidfile and has no other way to find the process holding the port.
 */
import {
  BIND_FAILURE_EXIT_CODE,
  claimPidFile,
  isAddressInUse,
  releasePidFile,
  type PidFileIo,
  type PidRelease,
} from './pidfile'

export interface BindLifecycleLog {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface BindLifecycleDeps {
  pidFile: string
  pid: number
  io: PidFileIo
  exit: (code: number) => void
  log?: BindLifecycleLog
  /** Only used to make the fatal message name the address that failed. */
  address?: string
}

export interface BindLifecycle {
  onListening(): void
  onError(err: unknown): void
  onShutdown(signal: string): PidRelease | 'unclaimed'
}

const SILENT: BindLifecycleLog = { info: () => {}, warn: () => {}, error: () => {} }

export function createBindLifecycle(deps: BindLifecycleDeps): BindLifecycle {
  const log = deps.log ?? SILENT
  const where = deps.address ? ` on ${deps.address}` : ''
  let listening = false
  let claimed = false
  let exited = false
  // Set once the release decision has been made. A second SIGTERM (or the
  // shutdown watchdog racing the normal-completion path) must not re-check
  // ownership and re-attempt an unlink of a file a takeover may have already
  // rewritten - it must simply repeat the first outcome.
  let shutdownOutcome: PidRelease | 'unclaimed' | null = null

  const fatal = (err: unknown): void => {
    // Idempotent: `ws` can surface the same bind failure on more than one
    // event, and exiting twice would double-run the shutdown path.
    if (exited) return
    exited = true
    const message = err instanceof Error ? err.message : String(err)
    if (isAddressInUse(err)) {
      log.error(
        `address already in use${where} - another switchboard server still owns this port. ` +
        `Refusing to start; the pid file is left pointing at the real owner so the next ` +
        `bootstrap can reclaim it. (${message})`,
      )
    } else {
      log.error(`failed to bind${where}: ${message}`)
    }
    deps.exit(BIND_FAILURE_EXIT_CODE)
  }

  return {
    onListening() {
      listening = true
      // Ownership is recorded ONLY here: before this point a bind can still
      // fail, and a pidfile written by a process that never listened is the
      // exact corruption that made a wedged server unkillable.
      if (claimPidFile(deps.io, deps.pidFile, deps.pid) === 'claimed') {
        claimed = true
      } else {
        log.warn(`failed to write pid file ${deps.pidFile} - stale-server cleanup will not find this process`)
      }
    },

    onError(err: unknown) {
      if (!listening) {
        fatal(err)
        return
      }
      // Post-bind: a socket-level fault must not take the backend down.
      log.error(`server error: ${err instanceof Error ? err.message : String(err)}`)
    },

    onShutdown(signal: string) {
      log.info(`${signal} - shutting down`)
      // Idempotent: call this once teardown has actually finished (or the
      // force-exit watchdog fires), never at signal receipt. Releasing the
      // pidfile while we are still listening would let a bootstrap that races
      // the (possibly slow) teardown see no owner, skip the kill it would
      // otherwise send, and start a second server that EADDRINUSEs against us
      // - the same class of bug this file exists to prevent, just earlier.
      if (shutdownOutcome !== null) return shutdownOutcome
      if (!claimed) {
        shutdownOutcome = 'unclaimed'
        return shutdownOutcome
      }
      const outcome = releasePidFile(deps.io, deps.pidFile, deps.pid)
      if (outcome === 'not-owner') {
        log.info('pid file belongs to a successor server - leaving it in place')
      }
      shutdownOutcome = outcome
      return outcome
    },
  }
}
