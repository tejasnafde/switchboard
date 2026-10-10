import { describe, expect, it } from 'vitest'
import { acpFsProblem } from '../../src/main/provider/adapters/acp/fs-access'

describe('acpFsProblem', () => {
  it('refuses a write in plan mode and allows it in the other modes', () => {
    expect(acpFsProblem('write', '/repo/a.ts', 'plan')).toMatch(/Plan mode/)
    expect(acpFsProblem('write', '/repo/a.ts', 'sandbox')).toBeNull()
    expect(acpFsProblem('write', '/repo/a.ts', 'full-access')).toBeNull()
  })

  it('lets plan mode read', () => {
    expect(acpFsProblem('read', '/repo/a.ts', 'plan')).toBeNull()
  })

  it('refuses a relative path and a request with no live session', () => {
    expect(acpFsProblem('read', 'a.ts', 'sandbox')).toMatch(/absolute/)
    expect(acpFsProblem('write', '/repo/a.ts', undefined)).toMatch(/No active session/)
  })
})
