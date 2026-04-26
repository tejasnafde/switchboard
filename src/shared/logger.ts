/**
 * Structured logger. Works in both main and renderer.
 * Prefix format: [SB:scope] — grep for "SB:" to filter switchboard logs.
 */

export function createLogger(scope: string) {
  const prefix = `[SB:${scope}]`

  return {
    debug: (...args: unknown[]) => console.debug(prefix, ...args),
    info: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  }
}
