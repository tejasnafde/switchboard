/** provisionRemote: probe -> plan -> (upload + install) over a faked runner. */
import { describe, it, expect, vi } from 'vitest'
import { provisionRemote } from '../../src/main/machines/provisioner'
import { execProc, makeExecProc } from '../../src/main/machines/provisionDeps'
import type { Machine } from '@shared/machines'

const machine: Machine = {
  id: 'm1', name: 'prod', sshAlias: 'prod-vm', sshHost: 'h', sshUser: 'u',
  sshPort: 22, remoteUser: null, sortOrder: 0, createdAt: 0, updatedAt: 0,
}
const inputs = { appVersion: '0.4.16', betterSqliteVersion: '12.9.0', claudeSdkVersion: '0.2.114', bundlePath: '/fake/out/server/index.cjs' }

// Every remote command (probe or step) is now wrapped through
// `printf %s '<b64>' | base64 -d | bash`, since asUserScript wraps the
// login-user passthrough case too (loads nvm for that user). Decode it to
// inspect the underlying script.
const decode = (remote: string): string => {
  const m = remote.match(/printf %s '([A-Za-z0-9+/=]+)'/)
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : remote
}

function runner(probe: Record<string, unknown>) {
  const calls: Array<{ args: string[]; stdin?: string | { file: string }; timeoutMs?: number }> = []
  const exec = vi.fn(async (_cmd: string, args: string[], stdin?: string | { file: string }, timeoutMs?: number) => {
    calls.push({ args, stdin, timeoutMs })
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

  it('install: mkdir, upload bundle + package.json, install, symlink, marker, in order', async () => {
    const r = runner({ ...full, server: null })
    const res = await provisionRemote(machine, inputs, r)
    expect(res.action).toBe('install')
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes[0]).toContain('node -e')
    expect(remotes[1]).toMatch(/mkdir -p/)
    expect(remotes[2]).toMatch(/cat > .*index\.cjs/)
    expect(remotes[3]).toMatch(/cat > .*package\.json/)
    expect(remotes[4]).toMatch(/npm install/)
    expect(remotes[5]).toMatch(/ln -sf .*\.local\/bin\/claude/)
    expect(remotes[6]).toMatch(/printf %s 0\.4\.16 > version/)
    expect(r.calls[2].stdin).toEqual({ file: '/fake/out/server/index.cjs' })
    expect(r.calls[3].stdin).toContain('better-sqlite3')
  })

  it('writes the version marker as the very last step so a half-finished install never probes ready', async () => {
    const r = runner({ ...full, server: null })
    await provisionRemote(machine, inputs, r)
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes[remotes.length - 1]).toContain('> version')
    expect(remotes.slice(0, -1).some((s) => s.includes('> version'))).toBe(false)
  })

  it('a claude CLI symlink failure is non-fatal: logged, and the marker is still written', async () => {
    const logs: string[] = []
    const r = runner({ ...full, server: null })
    r.exec.mockImplementation(async (_cmd: string, args: string[]) => {
      const remote = decode(args[args.length - 1])
      if (remote.includes('node -e')) return { code: 0, stdout: JSON.stringify({ ...full, server: null }), stderr: '' }
      if (remote.includes('ln -sf')) return { code: 1, stdout: '', stderr: 'no bundled claude CLI for linux-x64' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const res = await provisionRemote(machine, inputs, r, (msg) => logs.push(msg))
    expect(res.action).toBe('install')
    expect(logs.some((l) => l.includes('symlink failed (non-fatal)'))).toBe(true)
    const remotes = r.exec.mock.calls.map(([, args]) => decode(args[args.length - 1]))
    expect(remotes[remotes.length - 1]).toContain('> version')
  })

  it('bounds the probe with a short timeout while install steps keep the runner default', async () => {
    const r = runner({ ...full, server: null })
    await provisionRemote(machine, inputs, r)
    expect(r.calls[0].timeoutMs).toBe(30_000)
    const installCall = r.calls.find((c) => decode(c.args[c.args.length - 1]).includes('npm install'))
    expect(installCall?.timeoutMs).toBeUndefined()
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

  it('reports every install step through onProgress, in order', async () => {
    const steps: string[] = []
    const r = runner({ ...full, server: null })
    await provisionRemote(machine, inputs, r, undefined, (label) => steps.push(label))
    expect(steps).toEqual([
      'mkdir server dir',
      'upload server bundle',
      'upload package.json',
      'npm install (this can take a minute)',
      'link claude CLI onto PATH',
      'write version marker',
    ])
  })

  it('never fires onProgress when the probe reports ready', async () => {
    const steps: string[] = []
    const r = runner(full)
    await provisionRemote(machine, inputs, r, undefined, (label) => steps.push(label))
    expect(steps).toEqual([])
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

describe('execProc (real child processes)', () => {
  it('resolves with code + captured output on normal completion', async () => {
    const res = await execProc('sh', ['-c', 'printf hi; printf oops >&2; exit 3'])
    expect(res).toEqual({ code: 3, stdout: 'hi', stderr: 'oops' })
  })

  it('kills a hung command and rejects once the timeout elapses', async () => {
    await expect(execProc('sleep', ['30'], undefined, 100)).rejects.toThrow(
      /command timed out after 0\.1s/,
    )
  })

  it('does not time out a command that finishes within the limit', async () => {
    const res = await execProc('sh', ['-c', 'printf ok'], undefined, 5000)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('ok')
  })

  it('makeExecProc hands a kill handle to onSpawn that reaps the live child (user cancel)', async () => {
    let child: { kill: () => void } | undefined
    const exec = makeExecProc((c) => { child = c })
    const running = exec('sleep', ['30'], undefined, 60_000)
    expect(child).toBeDefined()
    child!.kill()
    const res = await running
    // Killed before completion: non-zero exit, and well before the timeout.
    expect(res.code).not.toBe(0)
  })
})
