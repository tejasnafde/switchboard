/**
 * Agent messages a session link refused only because its time was up. They
 * are held, not dropped: the backend delivers each one when the user renews
 * the link (a message typed in either chat, Send along it, `/link` again or
 * Extend) or when the target chat's session next starts. Kept in a store so a
 * backend restart, which removes every link, does not lose them either.
 *
 * A held message is also shown in the sender's chat as a Not delivered row
 * (`PeerUndelivered` with `held: true`) whose Send delivers it at once; once
 * it is delivered, either way, the row says so and the hold is gone.
 */

/**
 * Held messages one sender may have waiting for one target. Past it a send
 * is refused like a spent budget (and still kept as a Not delivered row), so
 * renewing a link never releases a flood the agent wrote while it was out.
 */
export const PEER_HELD_PER_EDGE_MAX = 3

export interface HeldPeerMessage {
  /** The Not delivered row's id (`peerUndeliveredId`), so a hand send and the hold name one message. */
  id: string
  /** The session id the agent sent from. */
  fromThreadId: string
  fromRoot: string
  fromLabel: string
  targetRoot: string
  targetLabel: string
  text: string
  heldAt: number
}

export interface HeldPeerMessageStore {
  all(): HeldPeerMessage[]
  put(message: HeldPeerMessage): void
  remove(id: string): void
}

export function memoryHeldPeerMessageStore(): HeldPeerMessageStore {
  const held = new Map<string, HeldPeerMessage>()
  return {
    all: () => [...held.values()].map((m) => ({ ...m })),
    put: (m) => {
      held.set(m.id, { ...m })
    },
    remove: (id) => {
      held.delete(id)
    },
  }
}

/** What the agent is told: the message is safe and will arrive, so it must not send it again. */
export function heldPeerMessageText(targetLabel: string): string {
  return (
    `The link with "${targetLabel}" is out of time, so Switchboard is holding this message. ` +
    `It is delivered when the user renews the link or "${targetLabel}" next starts. ` +
    'Do not send it again. Carry on with your own task, and end your turn rather than waiting for a reply.'
  )
}
