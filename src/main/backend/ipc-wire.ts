export const MAX_IPC_EMIT_BYTES = 32 * 1024 * 1024

interface IpcEmitMetadata {
  channel: string
  eventType?: string
  threadId?: string
  eventId?: string
}

export type PreparedIpcEmit =
  | (IpcEmitMetadata & { ok: true; args: unknown[]; bytes: number })
  | (IpcEmitMetadata & { ok: false; reason: string; bytes?: number })

function metadata(channel: string, args: unknown[]): IpcEmitMetadata {
  const first = args[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return { channel }
  const event = first as Record<string, unknown>
  const eventId = event.toolId ?? event.messageId ?? event.requestId ?? event.turnId
  return {
    channel,
    ...(typeof event.type === 'string' ? { eventType: event.type } : {}),
    ...(typeof event.threadId === 'string' ? { threadId: event.threadId } : {}),
    ...(typeof eventId === 'string' ? { eventId } : {}),
  }
}

/**
 * Electron's IPC serializer is a native fatal boundary: malformed host values
 * can abort the whole main process before JavaScript gets an exception. Keep
 * emits on the same JSON contract as the WebSocket host and enforce a hard
 * frame ceiling before calling webContents.send.
 */
export function prepareIpcEmit(
  channel: string,
  args: unknown[],
  maxBytes = MAX_IPC_EMIT_BYTES,
): PreparedIpcEmit {
  const details = metadata(channel, args)
  let encoded: string
  try {
    encoded = JSON.stringify(args)
  } catch {
    return { ok: false, ...details, reason: 'arguments are not JSON serializable' }
  }

  const bytes = Buffer.byteLength(encoded)
  if (bytes > maxBytes) {
    return { ok: false, ...details, bytes, reason: `emit exceeds ${maxBytes} byte IPC limit` }
  }

  return {
    ok: true,
    ...details,
    bytes,
    args: JSON.parse(encoded) as unknown[],
  }
}
