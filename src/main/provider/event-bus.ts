/**
 * Runtime event bus for the provider layer.
 *
 * Adapters always emit through a single per-session callback (`onEvent`).
 * Historically that callback wrote directly to `window.webContents.send`,
 * which coupled events 1:1 to the active renderer. That broke any flow
 * where main-process work outlives the renderer (closing a tab, closing
 * a window, background tasks for the kanban board).
 *
 * The bus inverts that: adapters publish to the bus, and N independent
 * subscribers consume. The renderer bridge is one subscriber; the
 * task-state recorder (used by background tasks / kanban) is another.
 * Adding a third — telemetry, replay, whatever — costs one `subscribe()`
 * call instead of a registry refactor.
 *
 * Implemented over Node's EventEmitter for zero-dep simplicity. The
 * single `'event'` channel is enough; type-narrowing happens in
 * subscribers via the discriminated `RuntimeEvent.kind` field.
 */

import { EventEmitter } from 'node:events'
import type { RuntimeEvent } from './types'

const CHANNEL = 'event'

/** Function signature subscribers register with `subscribe()`. */
export type RuntimeEventListener = (event: RuntimeEvent) => void

export class RuntimeEventBus {
  private emitter: EventEmitter

  constructor() {
    this.emitter = new EventEmitter()
    // Default 10 was hitting warnings as we grow subscribers (renderer +
    // recorder + future telemetry + kanban watcher). 50 leaves headroom
    // without masking real leaks.
    this.emitter.setMaxListeners(50)
  }

  /** Publish a runtime event. Subscribers run synchronously, in order. */
  publish(event: RuntimeEvent): void {
    this.emitter.emit(CHANNEL, event)
  }

  /**
   * Register a subscriber. Returns an unsubscribe fn — caller is
   * responsible for invoking it on teardown to avoid memory leaks.
   */
  subscribe(listener: RuntimeEventListener): () => void {
    this.emitter.on(CHANNEL, listener)
    return () => this.emitter.off(CHANNEL, listener)
  }

  /** Current subscriber count. Used by tests. */
  listenerCount(): number {
    return this.emitter.listenerCount(CHANNEL)
  }

  /** Drop every subscriber. Used on shutdown. */
  clear(): void {
    this.emitter.removeAllListeners(CHANNEL)
  }
}
