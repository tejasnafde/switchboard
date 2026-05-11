/**
 * Renderer-process logger. Mirrors the API of `src/main/logger.ts` so
 * callers look identical on both sides of the process boundary.
 *
 * Output goes to the browser DevTools console with a `[SB:scope]` prefix
 * that matches what main logs to its file + terminal, making grep across
 * both streams trivial during development.
 *
 * Usage (module level, same as main):
 *   const log = createRendererLogger('component:my-thing')
 *   log.info('started', { foo: 1 })
 *   log.warn('retrying', err)
 *   log.error('unrecoverable', err)
 */

export function createRendererLogger(scope: string) {
  const tag = `[SB:${scope}]`
  return {
    debug: (...args: unknown[]) => console.debug(tag, ...args),
    info:  (...args: unknown[]) => console.log(tag, ...args),
    warn:  (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  }
}
