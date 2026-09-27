/**
 * Per-chat credentials for the Switchboard MCP server.
 *
 * The backend mints one when a provider session starts and hands it to the
 * agent's MCP bridge in its environment. The token is the ONLY thing that
 * says which chat a tool call comes from, so the agent cannot claim another
 * chat's linked pull requests or another sender id. It stops working when the
 * session stops. Stored as a sha256 hash, like device sessions.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

function hash(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

export class McpTokens {
  /** hash (hex) → thread id. */
  private byHash = new Map<string, string>()
  /** thread id → hash (hex), so a restart of the same chat replaces its token. */
  private byThread = new Map<string, string>()

  mint(threadId: string): string {
    this.revoke(threadId)
    const token = randomBytes(32).toString('base64url')
    const h = hash(token).toString('hex')
    this.byHash.set(h, threadId)
    this.byThread.set(threadId, h)
    return token
  }

  /** The chat a token belongs to, or null when it is unknown or revoked. */
  resolve(token: unknown): string | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null
    const h = hash(token)
    const threadId = this.byHash.get(h.toString('hex'))
    if (!threadId) return null
    // The map lookup is already on a hash; this keeps the comparison constant-time anyway.
    const stored = Buffer.from(this.byThread.get(threadId) ?? '', 'hex')
    return stored.length === h.length && timingSafeEqual(stored, h) ? threadId : null
  }

  /** Returns whether the thread held a token. */
  revoke(threadId: string): boolean {
    const h = this.byThread.get(threadId)
    if (!h) return false
    this.byThread.delete(threadId)
    this.byHash.delete(h)
    return true
  }

  revokeAll(): void {
    this.byHash.clear()
    this.byThread.clear()
  }
}
