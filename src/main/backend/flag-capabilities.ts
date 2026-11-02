/**
 * The capabilities a `ready` frame carries: the fixed `BACKEND_CAPABILITIES`
 * plus those advertised only while a staged flag is on (`hubFlagCapabilities`).
 * The flag reader is set once the database is open, and read at each `ready`,
 * so a client learns a flag change on its next connect.
 */
import { BACKEND_CAPABILITIES } from '@shared/ws-protocol'
import { createMainLogger } from '../logger'

const log = createMainLogger('backend:capabilities')

let readFlagCapabilities: () => readonly string[] = () => []

export function setFlagCapabilities(read: () => readonly string[]): void {
  readFlagCapabilities = read
}

export function readyCapabilities(): string[] {
  try {
    return [...BACKEND_CAPABILITIES, ...readFlagCapabilities()]
  } catch (err) {
    log.warn('could not read the flag capabilities; advertising the fixed set', err)
    return [...BACKEND_CAPABILITIES]
  }
}
