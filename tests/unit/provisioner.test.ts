/** provisionRemote: probe -> plan -> (upload + install) over a faked runner. */
import { describe, it, expect, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionRemote } from '../../src/main/machines/provisioner'
import { bridgeMarker, REMOTE_CODEX_VERSION } from '../../src/main/machines/provisionSetup'
import { managedToolsMarker } from '../../src/main/machines/managedToolPlan'
import { execProc } from '../../src/main/machines/provisionDeps'
import { _resetShellEnvCacheForTests } from '../../src/main/shell-env'
import type { Machine } from '@shared/machines'

const machine: Machine = {
  id: 'm1', name: 'prod', sshAlias: 'prod-vm', sshHost: 'h', sshUser: 'u',
  sshPort: 22, remoteUser: null, sortOrder: 0, createdAt: 0, updatedAt: 0,
}
const inputs = { appVersion: '0.4.16', betterSqliteVersion: '12.9.0', claudeSdkVersion: '0.2.114', bundlePath: '/fake/out/server/index.cjs', bridgeFiles: [] }

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
  it('ready: probes and runs idempotent IDE/tool ensures, with no server upload', async () => {
    const r = runner(full)
    const res = await provisionRemote(machine, inputs, r)
    expect(res.action).toBe('ready')
    // probe + remote-IDE ensure + codex ensure. The `full` fixture reports no
    // managed executables at all, so claude's action is `install` - which a
    // ready server (no npm install this connect) cannot actually satisfy by
    // relinking, so that step - and the tools marker - are skipped rather than
    // falsely claimed. See the "leaves claude unconverged" test below.
    expect(r.exec).toHaveBeenCalledTimes(3)
    expect(decode(r.calls[1].args[r.calls[1].args.length - 1])).toContain('code-server')
    expect(res.tools?.satisfied).toBe(false)
  })

  it('leaves claude unconverged (never fakes a version we did not install) when it is missing on a server that probes ready', async () => {
    // A `ready` server never runs npm install this connect, so a genuinely
    // missing @anthropic-ai/claude-agent-sdk cannot be fixed by relinking
    // whatever happens to already be on disk. Attempting it and then writing
    // the tools marker as if it worked would claim a pinned version we never
    // actually installed - the exact silent-convergence bug managedToolPlan.ts
    // exists to prevent.
    const r = runner({ ...full, codexBin: '/home/u/.local/bin/codex', codexVersion: REMOTE_CODEX_VERSION })
    const res = await provisionRemote(machine, inputs, r)
    expect(res.action).toBe('ready')
    expect(res.tools?.claude.action).toBe('install')
    expect(res.tools?.satisfied).toBe(false)
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes.some((script) => script.includes('ln -sfn "$BIN" "$HOME/.local/bin/claude"'))).toBe(false)
    expect(remotes.some((script) => script.includes('> tools-version'))).toBe(false)
  })

  it('still relinks a genuinely repairable claude (correct version, dangling link) on a ready server', async () => {
    // The case this whole path exists for must keep working: a matching SDK
    // version already on disk, just missing its ~/.local/bin symlink.
    const r = runner({
      ...full,
      claudeVersion: inputs.claudeSdkVersion,
      claudeBin: null,
      codexBin: '/home/u/.local/bin/codex',
      codexVersion: REMOTE_CODEX_VERSION,
    })
    const res = await provisionRemote(machine, inputs, r)
    expect(res.tools?.claude.action).toBe('repair')
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes.some((script) => script.includes('ln -sfn "$BIN" "$HOME/.local/bin/claude"'))).toBe(true)
    expect(remotes.some((script) => script.includes('> tools-version'))).toBe(true)
  })

  it('skips the whole tool block when the probe proves both CLIs are current', async () => {
    const marker = managedToolsMarker({
      claudeSdkVersion: inputs.claudeSdkVersion,
      codexVersion: REMOTE_CODEX_VERSION,
    })
    const r = runner({
      ...full,
      claudeBin: '/home/u/.local/bin/claude',
      claudeVersion: inputs.claudeSdkVersion,
      codexBin: '/home/u/.local/bin/codex',
      codexVersion: REMOTE_CODEX_VERSION,
      tools: marker,
    })
    const res = await provisionRemote(machine, inputs, r)
    expect(res.tools?.satisfied).toBe(true)
    // probe + remote-IDE ensure only.
    expect(r.exec).toHaveBeenCalledTimes(2)
  })

  it('upgrades a codex CLI pinned to an older version even on a ready server', async () => {
    const r = runner({
      ...full,
      claudeBin: '/home/u/.local/bin/claude',
      claudeVersion: inputs.claudeSdkVersion,
      codexBin: '/home/u/.local/bin/codex',
      codexVersion: '0.144.1',
      tools: managedToolsMarker({ claudeSdkVersion: inputs.claudeSdkVersion, codexVersion: '0.144.1' }),
    })
    const res = await provisionRemote(machine, inputs, r)
    expect(res.tools?.codex.action).toBe('upgrade')
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes.some((script) => script.includes(`@openai/codex@${REMOTE_CODEX_VERSION}`))).toBe(true)
    // Claude was already current, so its link step is not re-run. (Match the
    // symlink command, not the bare path - the probe script names it too.)
    expect(remotes.some((script) => script.includes('ln -sfn "$BIN" "$HOME/.local/bin/claude"'))).toBe(false)
  })

  it('does not write the tools marker when a tool step failed', async () => {
    // A partial repair must re-run on the next connect rather than probe done.
    const r = runner({ ...full })
    r.exec.mockImplementation(async (_cmd: string, args: string[]) => {
      const remote = decode(args[args.length - 1])
      if (remote.includes('node -e')) return { code: 0, stdout: JSON.stringify(full), stderr: '' }
      if (remote.includes('@openai/codex@')) return { code: 1, stdout: '', stderr: 'npm ERR! network' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await provisionRemote(machine, inputs, r)
    const remotes = r.exec.mock.calls.map(([, args]) => decode(args[args.length - 1]))
    expect(remotes.some((script) => script.includes('> tools-version'))).toBe(false)
  })

  it('ensures Codex is installed for an already-provisioned remote server', async () => {
    const r = runner(full)
    await provisionRemote(machine, inputs, r)
    const remotes = r.calls.map((call) => decode(call.args[call.args.length - 1]))
    expect(remotes.some((script) => script.includes('@openai/codex@'))).toBe(true)
    expect(remotes.some((script) => script.includes('.local/bin/codex'))).toBe(true)
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
    expect(remotes[1]).toContain('code-server') // remote IDE ensure rides every connect
    expect(remotes[2]).toMatch(/mkdir -p/)
    expect(remotes[3]).toMatch(/cat > .*index\.cjs/)
    expect(remotes[4]).toMatch(/cat > .*package\.json/)
    expect(remotes[5]).toMatch(/npm install/)
    expect(remotes[6]).toMatch(/ln -sfn .*\.local\/bin\/claude/)
    expect(remotes[7]).toContain('.local/bin/codex')
    expect(remotes[8]).toContain('> tools-version')
    expect(remotes[9]).toMatch(/printf %s 0\.4\.16 > version/)
    expect(r.calls[3].stdin).toEqual({ file: '/fake/out/server/index.cjs' })
    expect(r.calls[4].stdin).toContain('better-sqlite3')
  })

  it('threads a codexVersion override into the uploaded package.json, not just the ensure script', async () => {
    // remotePackageJson used to always pin REMOTE_CODEX_VERSION regardless of
    // what the caller asked for, so an override reached codexEnsureScript but
    // not the package.json npm actually installs from - two different
    // versions chased on the same connect.
    const r = runner({ ...full, server: null })
    await provisionRemote(machine, { ...inputs, codexVersion: '0.150.0' }, r)
    const packageJsonCall = r.calls.find((c) => (c.stdin && typeof c.stdin === 'string') ? c.stdin.includes('"name": "switchboard-server"') : false)
    expect(packageJsonCall?.stdin).toContain('"@openai/codex": "0.150.0"')
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes.some((s) => s.includes('@openai/codex@0.150.0'))).toBe(true)
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
      if (remote.includes('ln -sfn "$BIN" "$HOME/.local/bin/claude"')) {
        return { code: 1, stdout: '', stderr: 'no bundled claude CLI for linux-x64' }
      }
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

  it('reports every install step through onStep, in order', async () => {
    const steps: string[] = []
    const r = runner({ ...full, server: null })
    await provisionRemote(machine, inputs, r, undefined, (label) => steps.push(label))
    expect(steps).toEqual([
      'checking remote',
      'ensure remote IDE (one-time download)',
      'mkdir server dir',
      'upload server bundle',
      'upload package.json',
      'npm install (this can take a minute)',
      'link claude CLI onto PATH',
      'ensure Codex CLI',
      'write managed tools marker',
      'write version marker',
    ])
  })

  it('fires only the probe + idempotent ensure steps when the remote is already ready', async () => {
    const steps: string[] = []
    const r = runner(full)
    await provisionRemote(machine, inputs, r, undefined, (label) => steps.push(label))
    // Codex is genuinely repairable via its own version-pinned install script
    // even on a ready server, so it still runs. Claude is not (see the
    // "leaves claude unconverged" test) - its link step and the tools marker
    // (which would otherwise falsely claim it) are both skipped.
    expect(steps).toEqual([
      'checking remote',
      'ensure remote IDE (one-time download)',
      'ensure Codex CLI',
    ])
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
  it.skipIf(process.platform === 'win32')('finds gcloud on the login-shell path when Finder supplied a minimal PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-gcloud-path-'))
    const bin = join(root, 'bin')
    const shell = join(root, 'login-shell')
    const gcloud = join(bin, 'gcloud')
    const previousPath = process.env.PATH
    const previousShell = process.env.SHELL
    try {
      mkdirSync(bin)
      writeFileSync(shell, `#!/bin/sh\nprintf 'PATH=${bin}:/usr/bin:/bin\\0'\n`)
      writeFileSync(gcloud, '#!/bin/sh\nprintf fake-gcloud\n')
      chmodSync(shell, 0o755)
      chmodSync(gcloud, 0o755)
      process.env.PATH = '/usr/bin:/bin'
      process.env.SHELL = shell
      _resetShellEnvCacheForTests()

      const res = await execProc('gcloud', ['--version'])

      expect(res).toEqual({ code: 0, stdout: 'fake-gcloud', stderr: '' })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousShell === undefined) delete process.env.SHELL
      else process.env.SHELL = previousShell
      _resetShellEnvCacheForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves with code + captured output on normal completion', async () => {
    const res = await execProc(process.execPath, [
      '-e',
      "process.stdout.write('hi'); process.stderr.write('oops'); process.exitCode = 3",
    ])
    expect(res).toEqual({ code: 3, stdout: 'hi', stderr: 'oops' })
  })

  it('kills a hung command and resolves code 1 with a timeout message once the limit elapses', async () => {
    const res = await execProc(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], undefined, 100)
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/command timed out after \d+s/)
  })

  it('does not time out a command that finishes within the limit', async () => {
    const res = await execProc(process.execPath, ['-e', "process.stdout.write('ok')"], undefined, 5000)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('ok')
  })
})

/**
 * Seeding sb-bridge onto the remote is what makes the VM's workbench able to
 * talk back to Switchboard at all. It rides every connect (like the code-server
 * install) because a version bump must reach an already-provisioned machine.
 */
describe('provisionRemote bridge extension seeding', () => {
  const withBridge = {
    ...inputs,
    bridgeFiles: [{ relPath: 'package.json', base64: 'cGtn' }],
  }

  it('seeds the bridge on an already-ready remote, right after the code-server ensure', async () => {
    const r = runner(full)
    const res = await provisionRemote(machine, withBridge, r)
    expect(res.action).toBe('ready')
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes[1]).toContain('code-server')
    // `base64 -d >` is unique to the seed: the probe also reads .sb-marker and
    // the ensure script also mentions ide-extensions.
    expect(remotes[2]).toContain('base64 -d >')
    expect(remotes[2]).toContain('base64 -d')
  })

  it('marks the seed with a payload hash so an edited extension re-seeds', async () => {
    const r = runner(full)
    await provisionRemote(machine, withBridge, r)
    expect(decode(r.calls[2].args[r.calls[2].args.length - 1])).toMatch(/\.sb-marker" 2>\/dev\/null\)" = "[a-f0-9]{16}"/)
  })

  it('skips the step entirely when the build has no bundled extension', async () => {
    const r = runner(full)
    const logs: string[] = []
    await provisionRemote(machine, { ...inputs, bridgeFiles: [] }, r, (m) => logs.push(m))
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes.some((s) => s.includes('base64 -d >'))).toBe(false)
    expect(logs.some((l) => l.includes('no bundled bridge extension'))).toBe(true)
  })

  it('does NOT ship the payload when the probe says the remote marker already matches', async () => {
    // The gate that matters for connect time: an upload to an IAP-tunneled host
    // costs ~2 minutes regardless of size, so a steady-state connect must send
    // nothing. Measured on a real VM before this gate existed.
    const marker = bridgeMarker(withBridge.bridgeFiles)
    const logs = []
    const r = runner({ ...full, bridge: marker })
    await provisionRemote(machine, withBridge, r, (m) => logs.push(m))
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes.some((s) => s.includes('base64 -d >'))).toBe(false)
    expect(logs.some((l) => l.includes('bridge extension already current'))).toBe(true)
  })

  it('ships the payload when the remote marker is stale (edited extension)', async () => {
    const r = runner({ ...full, bridge: 'deadbeefdeadbeef' })
    await provisionRemote(machine, withBridge, r)
    const remotes = r.calls.map((c) => decode(c.args[c.args.length - 1]))
    expect(remotes.some((s) => s.includes('base64 -d >'))).toBe(true)
  })

  it('is non-fatal: a failed seed still leaves a connectable backend', async () => {
    const logs: string[] = []
    const r = runner({ ...full, server: null })
    r.exec.mockImplementation(async (_cmd: string, args: string[]) => {
      const remote = decode(args[args.length - 1])
      if (remote.includes('node -e')) return { code: 0, stdout: JSON.stringify({ ...full, server: null }), stderr: '' }
          if (remote.includes('base64 -d >')) return { code: 1, stdout: '', stderr: 'disk full' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const res = await provisionRemote(machine, { ...withBridge, appVersion: '0.4.16' }, r, (m) => logs.push(m))
    expect(res.action).toBe('install')
    expect(logs.some((l) => l.includes('bridge extension seed failed (non-fatal)'))).toBe(true)
    // The version marker is still the final step, so the remote probes ready.
    const remotes = r.exec.mock.calls.map(([, args]) => decode(args[args.length - 1]))
    expect(remotes[remotes.length - 1]).toContain('> version')
  })
})
