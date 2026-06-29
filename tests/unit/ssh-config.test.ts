/**
 * Parser for ~/.ssh/config -> the host list that populates "Add machine".
 * Only real host aliases (no wildcards) with enough to connect are surfaced.
 */
import { describe, it, expect } from 'vitest'
import { parseSshConfig } from '../../src/main/machines/sshConfig'

describe('parseSshConfig', () => {
  it('extracts alias, hostName, user, and port from a block', () => {
    const cfg = `
Host prod-vm
  HostName 10.0.4.12
  User ubuntu
  Port 2222
`
    expect(parseSshConfig(cfg)).toEqual([{ alias: 'prod-vm', hostName: '10.0.4.12', user: 'ubuntu', port: 2222 }])
  })

  it('defaults port to 22 and leaves user undefined when absent', () => {
    const cfg = `Host gpu-box\n  HostName 192.168.1.50\n`
    expect(parseSshConfig(cfg)).toEqual([{ alias: 'gpu-box', hostName: '192.168.1.50', user: undefined, port: 22 }])
  })

  it('parses multiple blocks and ignores comments / blank lines', () => {
    const cfg = `
# work boxes
Host staging
  HostName staging.acme.dev
  User deploy

Host gpu-box
  HostName 192.168.1.50
  User tejas
`
    expect(parseSshConfig(cfg)).toEqual([
      { alias: 'staging', hostName: 'staging.acme.dev', user: 'deploy', port: 22 },
      { alias: 'gpu-box', hostName: '192.168.1.50', user: 'tejas', port: 22 },
    ])
  })

  it('skips wildcard / pattern hosts', () => {
    const cfg = `
Host *
  ForwardAgent yes

Host *.internal
  User admin

Host real
  HostName 10.0.0.9
`
    expect(parseSshConfig(cfg).map((h) => h.alias)).toEqual(['real'])
  })

  it('emits one entry per alias when a Host line lists several', () => {
    const cfg = `Host a b\n  HostName shared.example\n  User root\n`
    expect(parseSshConfig(cfg)).toEqual([
      { alias: 'a', hostName: 'shared.example', user: 'root', port: 22 },
      { alias: 'b', hostName: 'shared.example', user: 'root', port: 22 },
    ])
  })

  it('is case-insensitive on keywords and tolerant of indentation/tabs', () => {
    const cfg = `host weird\n\tHOSTNAME 1.2.3.4\n\tuSeR bob\n`
    expect(parseSshConfig(cfg)).toEqual([{ alias: 'weird', hostName: '1.2.3.4', user: 'bob', port: 22 }])
  })

  it('drops blocks with no HostName (nothing to connect to)', () => {
    const cfg = `Host ghost\n  User nobody\n\nHost real\n  HostName 10.0.0.1\n`
    expect(parseSshConfig(cfg).map((h) => h.alias)).toEqual(['real'])
  })

  it('returns [] for empty or whitespace input', () => {
    expect(parseSshConfig('')).toEqual([])
    expect(parseSshConfig('\n\n   \n')).toEqual([])
  })
})
