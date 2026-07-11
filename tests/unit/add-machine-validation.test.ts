/**
 * Pure helpers backing the Add-machine modal's hygiene fixes: dedupe against
 * already-added hosts, and reject garbage port input instead of silently
 * coercing it to 22.
 */
import { describe, it, expect } from 'vitest'
import { isDuplicateMachine, parsePort, validateManualMachine } from '../../src/renderer/components/sidebar/addMachineValidation'
import type { Machine } from '@shared/machines'

const mk = (over: Partial<Machine>): Machine => ({
  id: 'm1', name: 'prod', sshAlias: null, sshHost: '10.0.0.1', sshUser: null,
  sshPort: 22, remoteUser: null, sortOrder: 0, createdAt: 0, updatedAt: 0, ...over,
})

describe('isDuplicateMachine', () => {
  it('matches on ssh alias regardless of case', () => {
    const remotes = [mk({ sshAlias: 'Prod-Box' })]
    expect(isDuplicateMachine(remotes, { sshAlias: 'prod-box', sshHost: 'anything' })).toBe(true)
  })

  it('matches on user@host when neither side has an alias', () => {
    const remotes = [mk({ sshAlias: null, sshHost: 'box.example.com', sshUser: 'ubuntu' })]
    expect(isDuplicateMachine(remotes, { sshHost: 'BOX.example.com', sshUser: 'ubuntu' })).toBe(true)
  })

  it('does not flag distinct users on the same host', () => {
    const remotes = [mk({ sshAlias: null, sshHost: 'box.example.com', sshUser: 'ubuntu' })]
    expect(isDuplicateMachine(remotes, { sshHost: 'box.example.com', sshUser: 'root' })).toBe(false)
  })

  it('does not flag a genuinely new host', () => {
    const remotes = [mk({ sshAlias: 'a', sshHost: 'a.example.com' })]
    expect(isDuplicateMachine(remotes, { sshAlias: 'b', sshHost: 'b.example.com' })).toBe(false)
  })
})

describe('parsePort', () => {
  it('parses a valid port', () => {
    expect(parsePort('22')).toBe(22)
    expect(parsePort(' 8080 ')).toBe(8080)
    expect(parsePort('65535')).toBe(65535)
    expect(parsePort('1')).toBe(1)
  })

  it('rejects out-of-range ports', () => {
    expect(parsePort('0')).toBeNull()
    expect(parsePort('65536')).toBeNull()
    expect(parsePort('-1')).toBeNull()
  })

  it('rejects non-integer garbage instead of coercing to a default', () => {
    expect(parsePort('abc')).toBeNull()
    expect(parsePort('22.5')).toBeNull()
    expect(parsePort('')).toBeNull()
    expect(parsePort('22px')).toBeNull()
  })
})

describe('validateManualMachine', () => {
  it('rejects an empty or whitespace-only host', () => {
    expect(validateManualMachine([], { name: 'x', host: '', user: '', port: '22' }))
      .toEqual({ ok: false, reason: 'empty-host' })
    expect(validateManualMachine([], { name: 'x', host: '   ', user: '', port: '22' }))
      .toEqual({ ok: false, reason: 'empty-host' })
  })

  it('rejects an unparseable port', () => {
    expect(validateManualMachine([], { name: '', host: '10.0.0.9', user: '', port: 'abc' }))
      .toEqual({ ok: false, reason: 'invalid-port' })
  })

  it('flags a duplicate of an already-added remote - same check as the ssh-pick path', () => {
    const remotes = [mk({ sshAlias: null, sshHost: 'box.example.com', sshUser: 'ubuntu' })]
    expect(validateManualMachine(remotes, { name: '', host: ' BOX.example.com ', user: 'ubuntu', port: '22' }))
      .toEqual({ ok: false, reason: 'duplicate' })
  })

  it('passes a valid draft through, trimming and defaulting name to host', () => {
    expect(validateManualMachine([], { name: '  ', host: ' 10.0.0.9 ', user: '  ', port: ' 2222 ' })).toEqual({
      ok: true,
      input: { name: '10.0.0.9', sshHost: '10.0.0.9', sshUser: null, sshPort: 2222 },
    })
    expect(validateManualMachine([], { name: ' prod ', host: 'h.dev', user: ' deploy ', port: '22' })).toEqual({
      ok: true,
      input: { name: 'prod', sshHost: 'h.dev', sshUser: 'deploy', sshPort: 22 },
    })
  })

  it('lets an edited machine keep its own host when the caller filters it out of remotes', () => {
    const self = mk({ id: 'm-self', sshHost: 'h.dev', sshUser: 'deploy' })
    const others = [self, mk({ id: 'm-other', sshHost: 'other.dev' })]
    // Unfiltered: collides with itself.
    expect(validateManualMachine(others, { name: '', host: 'h.dev', user: 'deploy', port: '22' }).ok).toBe(false)
    // Filtered (edit mode): valid.
    expect(validateManualMachine(others.filter((m) => m.id !== 'm-self'), { name: '', host: 'h.dev', user: 'deploy', port: '22' }).ok).toBe(true)
  })
})
