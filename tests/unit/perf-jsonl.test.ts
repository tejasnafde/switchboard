import { expect, it } from 'vitest'
import { JsonlParser } from '../../src/main/agent/jsonl-parser'

it('counts physical JSONL lines across feeds, including ignored records', () => {
  const parser = new JsonlParser(() => {})
  parser.feed('{}\n\n{}')
  expect(parser.lineCount).toBe(2)
  parser.feed('\n{}')
  parser.flush()
  expect(parser.lineCount).toBe(4)
  parser.flush()
  expect(parser.lineCount).toBe(4)
})
