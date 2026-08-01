/**
 * Wire frames for the remote boundary (JSON codec): invoke → req/res
 * (correlated by id), send → snd, push → evt.
 *
 * Three concerns beyond plain RPC, all driven by the phone case:
 *
 *  - **Liveness.** A mobile socket dies without a FIN (carrier NAT rebind,
 *    radio off, OS suspend). Both ends still believe they are connected until
 *    something times out 30s later. `ping`/`pong` make that detectable in
 *    seconds.
 *  - **Resume.** `evt` frames carry a monotonic `seq`. A client that reconnects
 *    sends `hello { since }` and the server replays what it missed, so a
 *    backgrounded phone does not end up with a permanent hole in its
 *    transcript.
 *  - **Epoch.** The server mints a random `epoch` at startup. A restarted
 *    server resets `seq` to 0, so without this a client holding a high `since`
 *    would silently discard every subsequent event. A changed epoch means
 *    "start over".
 */

/** Channels excluded from the replay buffer.
 *
 *  Terminal output is high-volume and self-healing: a reattach re-seeds from
 *  the pty's own scrollback, so buffering it would evict the provider events
 *  that genuinely cannot be recovered any other way. */
export const NON_REPLAYABLE_EVENT_CHANNELS: ReadonlySet<string> = new Set(['terminal:data'])

export function isReplayableEventChannel(channel: string): boolean {
  return !NON_REPLAYABLE_EVENT_CHANNELS.has(channel)
}

export type WsFrame =
  | { k: 'req'; id: number; ch: string; args: unknown[] }
  | { k: 'res'; id: number; ok: true; result: unknown }
  | { k: 'res'; id: number; ok: false; error: string }
  | { k: 'snd'; ch: string; args: unknown[] }
  /** `seq` is absent on non-replayable channels - there is nothing to resume. */
  | { k: 'evt'; ch: string; args: unknown[]; seq?: number }
  /** Client → server, first frame after open. Requests replay from `since`. */
  | { k: 'hello'; since?: number; epoch?: string }
  /**
   * Server → client, answering `hello`. `gap` means the requested `since` had
   * already been evicted (or the epoch changed), so the client must re-seed
   * rather than assume continuity.
   */
  | { k: 'ready'; epoch: string; seq: number; replayed: number; gap: boolean }
  | { k: 'ping'; t: number }
  | { k: 'pong'; t: number }

export function encodeFrame(frame: WsFrame): string {
  return JSON.stringify(frame)
}

function isArgs(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/**
 * Parse a wire frame; returns null for anything that isn't a well-formed frame.
 *
 * This validates shape, not just the `k` discriminant. The previous blind cast
 * meant a frame like `{k:'req'}` reached a handler as `handler(...undefined)`
 * and threw deep inside application code instead of being rejected at the edge.
 */
export function decodeFrame(data: string): WsFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const frame = parsed as Record<string, unknown>
  switch (frame.k) {
    case 'req':
      if (typeof frame.id !== 'number' || typeof frame.ch !== 'string' || !isArgs(frame.args)) return null
      return { k: 'req', id: frame.id, ch: frame.ch, args: frame.args }
    case 'res': {
      if (typeof frame.id !== 'number') return null
      if (frame.ok === true) return { k: 'res', id: frame.id, ok: true, result: frame.result }
      if (frame.ok === false && typeof frame.error === 'string')
        return { k: 'res', id: frame.id, ok: false, error: frame.error }
      return null
    }
    case 'snd':
      if (typeof frame.ch !== 'string' || !isArgs(frame.args)) return null
      return { k: 'snd', ch: frame.ch, args: frame.args }
    case 'evt': {
      if (typeof frame.ch !== 'string' || !isArgs(frame.args)) return null
      const seq = typeof frame.seq === 'number' ? frame.seq : undefined
      return { k: 'evt', ch: frame.ch, args: frame.args, seq }
    }
    case 'hello': {
      const since = typeof frame.since === 'number' ? frame.since : undefined
      const epoch = typeof frame.epoch === 'string' ? frame.epoch : undefined
      return { k: 'hello', since, epoch }
    }
    case 'ready':
      if (
        typeof frame.epoch !== 'string' ||
        typeof frame.seq !== 'number' ||
        typeof frame.replayed !== 'number' ||
        typeof frame.gap !== 'boolean'
      )
        return null
      return { k: 'ready', epoch: frame.epoch, seq: frame.seq, replayed: frame.replayed, gap: frame.gap }
    case 'ping':
      if (typeof frame.t !== 'number') return null
      return { k: 'ping', t: frame.t }
    case 'pong':
      if (typeof frame.t !== 'number') return null
      return { k: 'pong', t: frame.t }
    default:
      return null
  }
}
