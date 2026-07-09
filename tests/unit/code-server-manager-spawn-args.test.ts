import { describe, it, expect } from 'vitest'
import { buildSpawnArgs } from '../../src/main/ide/code-server-manager'

describe('buildSpawnArgs', () => {
  const opts = {
    port: 41234,
    extensionsDir: '/Users/x/Library/Application Support/switchboard/code-server/extensions',
    userDataDir: '/Users/x/Library/Application Support/switchboard/code-server/data',
  }

  it('disables auth and binds to loopback on the given port', () => {
    const args = buildSpawnArgs(opts)
    const bindIdx = args.indexOf('--bind-addr')
    expect(args).toContain('--auth')
    expect(args[args.indexOf('--auth') + 1]).toBe('none')
    expect(bindIdx).toBeGreaterThanOrEqual(0)
    expect(args[bindIdx + 1]).toBe('127.0.0.1:41234')
  })

  it('passes extensions-dir and user-data-dir verbatim (no shell quoting - spawn takes an argv array)', () => {
    const args = buildSpawnArgs(opts)
    expect(args[args.indexOf('--extensions-dir') + 1]).toBe(opts.extensionsDir)
    expect(args[args.indexOf('--user-data-dir') + 1]).toBe(opts.userDataDir)
  })

  it('contains only the four documented flags', () => {
    const args = buildSpawnArgs(opts)
    const flags = args.filter((a) => a.startsWith('--'))
    expect(flags.sort()).toEqual(['--auth', '--bind-addr', '--extensions-dir', '--user-data-dir'])
    expect(args).toHaveLength(8)
  })
})
