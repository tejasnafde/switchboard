/** provisionRemote: probe -> plan -> (upload + install) over a faked runner. */
import { describe, it, expect, vi } from 'vitest'
import { provisionRemote } from '../../src/main/machines/provisioner'
import type { Machine } from '@shared/machines'

const machine: Machine = {
  id: 'm1', name: 'prod', sshAlias: 'prod-vm', sshHost: 'h', sshUser: 'u',
  sshPort: 22, remoteUser: null, sortOrder: 0, createdAt: 0, updatedAt: 0,
}
const inputs = { appVersion: '0.4.16', betterSqliteVersion: '12.9.0', bundle: 'BUNDLE_BYTES' }

// Every remote command (probe or step) is now wrapped through
// `printf %s '<b64>' | base64 -d | bash`, since asUserScript wraps the
// login-user passthrough case too (loads nvm for that user). Decode it to
// inspect the underlying script.
const decode = (remote: string): string => {
  const m = remote.match(/printf %s '([A-Za-z0-9+/=]+)'/)
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : remote
}

function runner(probe: Record<string, unknown>) {
  const calls: Array<{ args: string[]; stdin?: string }> = []
  const exec = vi.fn(async (_cmd: string, args: string[], stdin?: string) => {
    calls.push({ args, stdin })
    const remote = decode(args[args.length - 1])
    if (remote.includes('node -e')) return { code: 0, stdout: JSON.stringify(probe), stderr: '' }
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
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes[0]).toContain('node -e')
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
      const remote = decode(args[args.length - 1])
      if (remote.includes('node -e')) return { code: 0, stdout: JSON.stringify({ ...full, server: null }), stderr: '' }
      if (remote.includes('npm install')) return { code: 1, stdout: '', stderr: 'npm boom' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(provisionRemote(machine, inputs, r)).rejects.toThrow(/npm boom/)
  })

  it('throws a clear error when the ssh probe itself fails (auth, unreachable, sudo needs password)', async () => {
    const exec = vi.fn(async () => ({ code: 255, stdout: '', stderr: 'Permission denied (publickey).' }))
    await expect(provisionRemote(machine, inputs, { exec })).rejects.toThrow(
      /ssh probe failed \(255\): Permission denied \(publickey\)\./,
    )
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('throws when the remote node is too old for the server bundle (needs >= 20)', async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ ...full, node: 'v18.19.0' }),
      stderr: '',
    }))
    await expect(provisionRemote(machine, inputs, { exec })).rejects.toThrow(
      /remote node v18\.19\.0 is too old, need >= 20/,
    )
  })

  it('accepts node versions at or above the minimum', async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ ...full, node: 'v20.11.0' }),
      stderr: '',
    }))
    const res = await provisionRemote(machine, inputs, { exec })
    expect(res.action).toBe('ready')
  })
})
