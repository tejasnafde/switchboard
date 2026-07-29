/**
 * Stall detection for agent turns.
 *
 * A turn that produces no SDK messages is invisible to the renderer: no
 * turn.completed, no error, just a spinner that never resolves. Reports
 * silence longer than `stallMs`, except inside a suspend()/resume() window
 * where silence is expected (a running tool, a prompt awaiting the user).
 * Callers drive check(now) from an interval, so no timers live here.
 */
export class TurnWatchdog {
  private inTurn = false
  private lastActivityAt = 0
  private reportedForActivityAt: number | null = null
  private suspensions = 0

  constructor(
    private readonly stallMs: number,
    private readonly onStall: (idleMs: number) => void,
  ) {}

  turnStarted(nowMs: number): void {
    this.inTurn = true
    this.lastActivityAt = nowMs
    this.reportedForActivityAt = null
    // A turn killed mid-tool leaves its suspend() unmatched. No tool from a
    // finished turn can still be running, so a new turn starts unsuspended.
    this.suspensions = 0
  }

  /** Any SDK message counts as life - resets the idle clock and re-arms. */
  activity(nowMs: number): void {
    this.lastActivityAt = nowMs
    this.reportedForActivityAt = null
  }

  /** Enter a window where silence is expected (tool run, pending approval). */
  suspend(): void {
    this.suspensions++
  }

  /** Leave the expected-silence window; counts as activity. */
  resume(nowMs: number): void {
    if (this.suspensions > 0) this.suspensions--
    this.activity(nowMs)
  }

  turnEnded(): void {
    this.inTurn = false
    this.reportedForActivityAt = null
  }

  /** Called from an interval. Reports at most once per silent stretch. */
  check(nowMs: number): void {
    if (!this.inTurn || this.suspensions > 0) return
    if (this.reportedForActivityAt === this.lastActivityAt) return
    const idleMs = nowMs - this.lastActivityAt
    if (idleMs < this.stallMs) return
    this.reportedForActivityAt = this.lastActivityAt
    this.onStall(idleMs)
  }
}

/**
 * Suspend the watchdog for each `tool_use` an assistant message starts and
 * resume for each `tool_result` that comes back, so a long-running tool's
 * silence never reads as a stall.
 */
export function countToolBrackets(msg: unknown, watchdog: TurnWatchdog, nowMs: number): void {
  const content = (msg as { message?: { content?: unknown } })?.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    const kind = (block as { type?: string })?.type
    if (kind === 'tool_use') watchdog.suspend()
    else if (kind === 'tool_result') watchdog.resume(nowMs)
  }
}

/** Rolling tail of a subprocess's stderr, capped at `maxChars`. */
export class StderrTail {
  private buffer = ''

  constructor(private readonly maxChars: number) {}

  push(data: string): void {
    this.buffer = (this.buffer + data).slice(-this.maxChars)
  }

  tail(): string {
    return this.buffer
  }
}
