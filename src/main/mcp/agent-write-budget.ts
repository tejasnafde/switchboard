import { AGENT_WRITE_BUDGET, AGENT_WRITE_WINDOW_MS } from '@shared/agent-host-writes'

/**
 * Pull request writes per chat inside a sliding window. Counted when a write
 * reaches its card, approved or not: an agent that keeps asking is the thing
 * this stops, and every ask interrupts the user.
 */
export class AgentWriteBudget {
  private stamps = new Map<string, number[]>()

  constructor(
    private readonly limit = AGENT_WRITE_BUDGET,
    private readonly windowMs = AGENT_WRITE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Charge one write, or return the refusal the model is shown. */
  take(chatId: string): { ok: true } | { ok: false; message: string } {
    const now = this.now()
    const recent = (this.stamps.get(chatId) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.limit) {
      const waitS = Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000))
      this.stamps.set(chatId, recent)
      return {
        ok: false,
        message: `This chat has asked for ${this.limit} pull request writes in the last ${Math.round(this.windowMs / 60_000)} minutes, which is the limit. ` +
          `Nothing was sent. Tell the user what is left to do, or try again in ${waitS} seconds.`,
      }
    }
    recent.push(now)
    this.stamps.set(chatId, recent)
    return { ok: true }
  }
}
