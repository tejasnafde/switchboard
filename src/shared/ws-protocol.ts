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

/**
 * Channels excluded from the replay buffer. Terminal output is high-volume and
 * re-seeds itself on reattach, so buffering it evicts provider events that
 * cannot be recovered, and replaying it repaints output the user has seen.
 *
 * SERVER-TO-CLIENT names only, since those are the ones that travel as `evt`.
 * `terminal:data` is the client-to-server keystroke channel and belongs here.
 */
export const NON_REPLAYABLE_EVENT_CHANNELS: ReadonlySet<string> = new Set([
  'terminal:output',
  'terminal:exit',
])

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
  /**
   * Credential, in a frame rather than the URL: a query string lands in proxy
   * logs and process listings. `pairing` is the one-time QR code, exchanged
   * once for a `session`, which every later connect presents.
   */
  | { k: 'auth'; session?: string; pairing?: string; label?: string }
  /** Verdict. `session` carries the minted token on a pairing exchange, which
   *  is the only time it is transmitted. */
  | { k: 'authed'; ok: true; session?: string; scopes: string[] }
  | { k: 'authed'; ok: false; error: string }

export function encodeFrame(frame: WsFrame): string {
  return JSON.stringify(frame)
}

function isArgs(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/**
 * Parse a wire frame; null for anything malformed. Validates shape, not just
 * `k`: a blind cast let `{k:'req'}` reach a handler as `handler(...undefined)`
 * and throw deep in application code instead of being rejected at the edge.
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
    case 'auth': {
      const session = typeof frame.session === 'string' ? frame.session : undefined
      const pairing = typeof frame.pairing === 'string' ? frame.pairing : undefined
      const label = typeof frame.label === 'string' ? frame.label : undefined
      // Neither credential is malformed, not anonymous: letting it through
      // would make the auth step optional.
      if (!session && !pairing) return null
      return { k: 'auth', session, pairing, label }
    }
    case 'authed': {
      if (frame.ok === true) {
        if (!Array.isArray(frame.scopes) || frame.scopes.some((x) => typeof x !== 'string')) return null
        return {
          k: 'authed',
          ok: true,
          session: typeof frame.session === 'string' ? frame.session : undefined,
          scopes: frame.scopes as string[],
        }
      }
      if (frame.ok === false && typeof frame.error === 'string') {
        return { k: 'authed', ok: false, error: frame.error }
      }
      return null
    }
    default:
      return null
  }
}
