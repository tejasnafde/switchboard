/**
 * Shiki cold-start is a real perf risk: WASM init + grammar loading runs
 * 50–200 ms. We must NOT pay that on every FileViewerPane mount. The
 * singleton (module-level memo, terminal-registry pattern) ensures one
 * highlighter for the whole session.
 *
 * This regression test injects a counting stub for `createHighlighter` and
 * asserts two `getHighlighter()` calls hit the underlying API exactly
 * once. If a future refactor accidentally swaps the singleton for a
 * per-mount instance, this test fails.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  __resetShikiSingletonForTests,
  __setShikiFactoryForTests,
  getHighlighter,
} from '../../src/renderer/services/shikiHighlighter'

beforeEach(() => {
  __resetShikiSingletonForTests()
})

describe('shiki highlighter singleton', () => {
  it('calls createHighlighter exactly once across many getHighlighter calls', async () => {
    const factory = vi.fn().mockResolvedValue({ codeToHtml: () => '' })
    __setShikiFactoryForTests(factory as any)

    await getHighlighter()
    await getHighlighter()
    await getHighlighter()

    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('returns the same instance across calls', async () => {
    const stub = { codeToHtml: () => '<span/>' }
    __setShikiFactoryForTests(vi.fn().mockResolvedValue(stub) as any)

    const a = await getHighlighter()
    const b = await getHighlighter()
    expect(a).toBe(b)
    expect(a).toBe(stub)
  })

  it('coalesces concurrent first-init calls into one factory invocation', async () => {
    const factory = vi.fn().mockResolvedValue({ codeToHtml: () => '' })
    __setShikiFactoryForTests(factory as any)

    // Fire many in parallel before any awaits resolve.
    await Promise.all([getHighlighter(), getHighlighter(), getHighlighter(), getHighlighter()])
    expect(factory).toHaveBeenCalledTimes(1)
  })
})
