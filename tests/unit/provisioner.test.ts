/** provisionRemote: probe -> plan -> (upload + install) over a faked runner. */
import { describe, it, expect, vi } from 'vitest'
import { provisionRemote } from '../../src/main/machines/provisioner'
import type { Machine } from '@shared/machines'

const machine: Machine = {
  id: 'm1', name: 'prod', sshAlias: 'prod-vm', sshHost: 'h', sshUser: 'u',
  sshPort: 22, sortOrder: 0, createdAt: 0, updatedAt: 0,
}
const inputs = { appVersion: '0.4.16', betterSqliteVersion: '12.9.0', bundle: 'BUNDLE_BYTES' }

function runner(probe: Record<string, unknown>) {
  const calls: Array<{ args: string[]; stdin?: string }> = []
  const exec = vi.fn(async (_cmd: string, args: string[], stdin?: string) => {
    calls.push({ args, stdin })
    const remote = args[args.length - 1]
    if (remote.startsWith('node -e')) return { code: 0, stdout: JSON.stringify(probe), stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  })
  return { calls, exec }
}

const full = { node: 'v20', platform: 'linux', arch: 'x64', abi: '115', server: '0.4.16' }

describe('provisionRemote', () => {
  it('ready: probes only, no upload/install', async () => {
    const r = runner(full)
    const res = await provisionRemote(machine, inputs, r)
    expect(res.action).toBe('ready')
    expect(r.exec).toHaveBeenCalledTimes(1)
  })

  it('no-node: stops after the probe', async () => {
    const r = runner({ ...full, node: null })
    const res = await provisionRemote(machine, inputs, r)
    expect(res.action).toBe('no-node')
    expect(r.exec).toHaveBeenCalledTimes(1)
  })

  it('install: mkdir, upload bundle + package.json, run install, in order', async () => {
    const r = runner({ ...full, server: null })
    const res = await provisionRemote(machine, inputs, r)
    expect(res.action).toBe('install')
    const remotes = r.calls.map((c) => c.args[c.args.length - 1])
    expect(remotes[0]).toMatch(/^node -e/)
    expect(remotes[1]).toMatch(/mkdir -p/)
    expect(remotes[2]).toMatch(/cat > .*index\.cjs/)
    expect(remotes[3]).toMatch(/cat > .*package\.json/)
    expect(remotes[4]).toMatch(/npm install/)
    expect(r.calls[2].stdin).toBe('BUNDLE_BYTES')
    expect(r.calls[3].stdin).toContain('better-sqlite3')
  })

  it('upgrade when the installed version differs', async () => {
    const res = await provisionRemote(machine, inputs, runner({ ...full, server: '0.4.10' }))
    expect(res.action).toBe('upgrade')
  })

  it('throws when a remote step fails', async () => {
    const r = runner({ ...full, server: null })
    r.exec.mockImplementation(async (_cmd: string, args: string[]) => {
      const remote = args[args.length - 1]
      if (remote.startsWith('node -e')) return { code: 0, stdout: JSON.stringify({ ...full, server: null }), stderr: '' }
      if (remote.includes('npm install')) return { code: 1, stdout: '', stderr: 'npm boom' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(provisionRemote(machine, inputs, r)).rejects.toThrow(/npm boom/)
  })
})
