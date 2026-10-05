import { expect, it } from 'vitest'
import { retainedJsonBytes } from '../../src/main/agent/jsonl-memory'

it('budgets retained image and tool strings rather than source transcript bytes', () => {
  const small = retainedJsonBytes([{ content: 'hello', toolCalls: [{ input: { path: '/a' } }] }])
  const large = retainedJsonBytes([{ content: 'hello', images: [{ url: 'x'.repeat(100_000) }] }])
  expect(large).toBeGreaterThan(small + 199_000)
  expect(retainedJsonBytes(null)).toBe(0)
})

it('handles deeply nested tool inputs without overflowing the main process stack', () => {
  let value: unknown = 'body'
  for (let i = 0; i < 20_000; i++) value = { child: value }
  expect(retainedJsonBytes(value)).toBeGreaterThan(20_000 * 64)
})
