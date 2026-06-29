/**
 * Wire protocol for the remote backend boundary. A thin correlation-id layer
 * over WebSocket text frames so the Transport (client) and BackendHost (server)
 * agree on framing. JSON is the codec — frames are small and human-debuggable.
 *
 *   invoke  → req  → res        (correlated by id)
 *   send    → snd               (fire-and-forget, no reply)
 *   on/emit ← evt               (server push)
 */

export type WsFrame =
  | { k: 'req'; id: number; ch: string; args: unknown[] }
  | { k: 'res'; id: number; ok: true; result: unknown }
  | { k: 'res'; id: number; ok: false; error: string }
  | { k: 'snd'; ch: string; args: unknown[] }
  | { k: 'evt'; ch: string; args: unknown[] }

export function encodeFrame(frame: WsFrame): string {
  return JSON.stringify(frame)
}

/** Parse a wire frame; returns null for anything that isn't a known frame. */
export function decodeFrame(data: string): WsFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const k = (parsed as { k?: unknown }).k
  if (k === 'req' || k === 'res' || k === 'snd' || k === 'evt') return parsed as WsFrame
  return null
}
