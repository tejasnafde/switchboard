import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const hook = readFileSync(new URL('../../scripts/pre-commit.sh', import.meta.url), 'utf8')

describe('pre-commit native runtime selection', () => {
  it('keeps the normal Node suite and runs SQLite acceptance tests with Electron when required', () => {
    expect(hook).toContain("new Database(':memory:').close()")
    expect(hook).toContain('npm test')
    expect(hook).toContain('--exclude tests/unit/durable-turn-acceptance.test.ts')
    expect(hook).toContain('--exclude tests/unit/turn-acceptance-store.test.ts')
    expect(hook).toContain('ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron')
  })
})
