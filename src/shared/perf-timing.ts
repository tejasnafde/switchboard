export const PERF_THRESHOLDS = {
  'chat.open': 300,
  'chat.load': 300,
  'chat.load-older': 300,
  'chat.load-full': 1000,
  'chat.load-tool-call': 200,
  'provider.switch': 1000,
  'provider.switch.action': 1000,
  'provider.switch.first-event': 1000,
  'provider.stop': 1000,
  'provider.start': 1000,
  'provider.first-event': 1000,
  'turn.first-content': 1000,
  'turn.dispatch': 1000,
  'transcript.compare': 1000,
  'transcript.copy': 1000,
  'handoff.build': 300,
  'db.migrate': 1000,
  'db.migrate-slow': 1000,
  // Fires are rare (one per usage limit), so every one is logged: counts, outcomes, probe time.
  'limit-resume.fire': 0,
  // Child chats: every batch, child start, child turn end and 30 s resource sample is logged.
  'hub.batch': 0,
  'hub.start-child': 0,
  'hub.child-turn': 0,
  'hub.resources': 0,
  // Each child turn end; the changed outcome also logs a warning.
  'hub.deps-check': 200,
  'hub.own-deps': 0,
  // Per base commit of a start_children call: git show and lockfile reads per folder.
  'hub.deps-plan': 200,
  // A chat's children view (strip, banner, chip): DB reads per open, per change event.
  'hub.view': 100,
  // Every wake turn (wakes, bytes, attempt, outcome, ms to first activity) and every read_child call.
  'hub.wake': 0,
  'hub.read-child': 0,
  // Stop on a parent (children, stopped, failed, ms), each idle reap, and each reaped child's restart.
  'hub.stop': 0,
  'hub.reap': 0,
  'hub.resume-reaped': 0,
  // Every move_child call, with its outcome (moved, or why not).
  'hub.move': 0,
  // Every settle (children, removed, kept, stop failures, killed processes), and each list_children conflict scan.
  'hub.settle': 0,
  'hub.conflicts': 0,
  // A hub-remote:describe answer: one git read per project, capped at 200 projects.
  'hub.remote-describe': 500,
  // Each desktop-to-machine hub call: channel, machine id, outcome.
  'hub.remote-call': 200,
  // One child on another machine: the desktop's start call, and the checkout, clone and fetch there.
  'hub.remote-start': 0,
  // One desktop pull of a machine's outbox: pages, items, the oldest item's age, outcome.
  'hub.outbox-pull': 0,
  // The pending stops of one machine sent on its connect: rows, sent, outcome.
  'hub.remote-pending': 0,
  // A parent's message to its child on another machine, after the charge here: delivery, outcome.
  'hub.remote-deliver': 200,
  // A machine that was connected before came back: down ms, its open children, outbox items pulled.
  'hub.remote-reconnect': 0,
  ipc: 200,
} as const

export type PerfFields = Record<string, string | number | boolean | null | undefined>
export type PerfName = keyof typeof PERF_THRESHOLDS
export interface PerfSpan {
  end: (fields?: PerfFields) => number
}

export function createPerfSpan(
  log: { info: (line: string) => void; debug: (line: string) => void },
  clock: () => number = () => performance.now(),
) {
  return (name: PerfName, fields: PerfFields = {}): PerfSpan => {
    const start = clock()
    let elapsed: number | undefined
    return {
      end(extraFields = {}) {
        if (elapsed !== undefined) return elapsed
        elapsed = clock() - start
        const line = `${name} ${Math.round(elapsed)}ms ${JSON.stringify({ ...fields, ...extraFields })}`
        if (elapsed > PERF_THRESHOLDS[name]) log.info(line)
        else log.debug(line)
        return elapsed
      },
    }
  }
}
