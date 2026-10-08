export const PERF_THRESHOLDS = {
  'chat.open': 300,
  'chat.load': 300,
  'provider.switch': 1000,
  'provider.switch.action': 1000,
  'provider.switch.first-event': 1000,
  'provider.stop': 1000,
  'provider.start': 1000,
  'provider.first-event': 1000,
  'turn.first-content': 1000,
  'transcript.compare': 1000,
  'transcript.copy': 1000,
  'handoff.build': 300,
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
