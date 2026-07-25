/**
 * Fan-out BackendHost: registers one set of handlers on several hosts at once
 * so the desktop app can serve its renderer (ElectronIpcHost) AND paired mobile
 * clients (WsHost) from a SINGLE ProviderRegistry / handler set. That shared
 * registry is the point: sessions started on the phone and sessions started on
 * the desktop live in the same pool, and every runtime event reaches both.
 *
 * emit() broadcasts to all hosts. handle() registers the same fn everywhere, so
 * whichever transport a request arrives on runs identical code.
 */
import { createMainLogger as createLogger } from '../logger'
import type { BackendHost } from './host'

const log = createLogger('backend:multi-host')

export class MultiHost implements BackendHost {
  private readonly hosts: BackendHost[]

  constructor(...hosts: BackendHost[]) {
    this.hosts = hosts.filter(Boolean)
    log.info(`fanning out over ${this.hosts.length} host(s)`)
  }

  handle<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    for (const host of this.hosts) host.handle(channel, fn)
  }

  on<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => void): void {
    for (const host of this.hosts) host.on(channel, fn)
  }

  emit(channel: string, ...args: unknown[]): void {
    for (const host of this.hosts) {
      // One bad host (destroyed window, dead socket set) must not stop the
      // others from receiving the event.
      try {
        host.emit(channel, ...args)
      } catch (err) {
        log.warn(`emit failed on one host for ${channel}`, err)
      }
    }
  }
}
