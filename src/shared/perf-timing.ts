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
