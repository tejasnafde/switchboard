/**
 * Auto-provisioning decision logic (pure). On connect we ssh-probe the remote
 * for node + an installed server marker, then decide whether to install,
 * upgrade, or launch as-is. No ssh here - just parsing + the decision.
 */
import { describe, it, expect } from 'vitest'
import { parseProbeOutput } from '../../src/main/machines/remoteProbe'
import { planProvision } from '../../src/main/machines/provisionPlan'
import { buildProbeCommand } from '../../src/main/machines/provisionCommands'
import type { Machine } from '@shared/machines'

describe('parseProbeOutput', () => {
  const line = JSON.stringify({ node: 'v20.11.0', platform: 'linux', arch: 'x64', abi: '115', server: '0.4.16' })

  it('parses the probe JSON line', () => {
    expect(parseProbeOutput(line)).toEqual({
      node: 'v20.11.0', platform: 'linux', arch: 'x64', abi: '115', server: '0.4.16',
    })
  })

  it('tolerates surrounding noise (motd, warnings) around the JSON', () => {
    const noisy = `Welcome to Ubuntu\n${line}\n`
    expect(parseProbeOutput(noisy).abi).toBe('115')
  })

  it('returns all-null when node is absent (empty / garbage output)', () => {
    expect(parseProbeOutput('')).toEqual({ node: null, platform: null, arch: null, abi: null, server: null })
    expect(parseProbeOutput('bash: node: command not found')).toEqual({
      node: null, platform: null, arch: null, abi: null, server: null,
    })
  })

  it('reads a null server marker when only node is present', () => {
    const noServer = JSON.stringify({ node: 'v20.11.0', platform: 'linux', arch: 'arm64', abi: '115', server: null })
    expect(parseProbeOutput(noServer).server).toBeNull()
    expect(parseProbeOutput(noServer).arch).toBe('arm64')
  })
})

describe('planProvision', () => {
  const probe = (over = {}) => parseProbeOutput(JSON.stringify({
    node: 'v20.11.0', platform: 'linux', arch: 'x64', abi: '115', server: '0.4.16', ...over,
  }))

  it('no-node when the remote has no node runtime', () => {
    expect(planProvision(probe({ node: null }), '0.4.16').action).toBe('no-node')
  })

  it('install when no server marker is present', () => {
    expect(planProvision(probe({ server: null }), '0.4.16').action).toBe('install')
  })

  it('upgrade when the installed version differs from local', () => {
    expect(planProvision(probe({ server: '0.4.10' }), '0.4.16').action).toBe('upgrade')
  })

  it('ready when versions match', () => {
    expect(planProvision(probe(), '0.4.16').action).toBe('ready')
  })
})

describe('buildProbeCommand', () => {
  const mk = (over: Partial<Machine> = {}): Machine => ({
    id: 'm1', name: 'prod', sshAlias: null, sshHost: 'h.dev', sshUser: 'ubuntu',
    sshPort: 22, sortOrder: 0, createdAt: 0, updatedAt: 0, ...over,
  })

  it('runs a node probe over ssh, batch-mode, on the resolved host', () => {
    const { command, args } = buildProbeCommand(mk({ sshAlias: 'prod-vm' }))
    expect(command).toBe('ssh')
    expect(args).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes']))
    expect(args).toContain('prod-vm')
    expect(args[args.length - 1]).toMatch(/^node -e/)
  })

  it('the probe source has no double quotes (survives the remote shell)', () => {
    const { args } = buildProbeCommand(mk())
    const remoteCmd = args.at(-1) as string
    const inner = remoteCmd.slice(remoteCmd.indexOf('"') + 1, remoteCmd.lastIndexOf('"'))
    expect(inner).not.toContain('"')
    expect(args).toContain('ubuntu@h.dev')
  })
})
