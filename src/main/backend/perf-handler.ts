import { PERF_THRESHOLDS } from '@shared/perf-timing'
import { perfSpan } from '../perf'

// These handlers can await an entire turn or a human answer by design.
export const LONG_RUNNING_CHANNELS = new Set([
  'provider:send-turn',
  'provider:submit-user-turn',
  'provider:respond-to-request',
  'provider:answer-question',
  'provider:deliver-peer-message',
])

export function timeBackendHandler<A extends unknown[]>(
  channel: string,
  fn: (...args: A) => unknown,
): (...args: A) => unknown {
  if (LONG_RUNNING_CHANNELS.has(channel)) return fn
  return (...args) => {
    const start = performance.now()
    const span = perfSpan('ipc', { channel })
    const end = () => {
      if (performance.now() - start > PERF_THRESHOLDS.ipc) span.end()
    }
    try {
      const result = fn(...args)
      if (result instanceof Promise) return result.finally(end)
      end()
      return result
    } catch (error) {
      end()
      throw error
    }
  }
}
