/**
 * Managed remote CLI provisioning, tracked INDEPENDENTLY of the server version.
 *
 * Field evidence: all CLI repair hung off the `$HOME/.switchboard-server/version`
 * marker. A remote whose marker already equalled the app version probed as
 * `ready`, returned early, and therefore never relinked a missing `claude` nor
 * compared the installed `codex` version against the one we pin. A managed tool
 * could be absent or years out of date on a "ready" server indefinitely.
 *
 * So the tool plan reads the PROBED EXECUTABLES AND VERSIONS, not the app
 * version, and carries its own marker.
 */
import { describe, it, expect } from 'vitest'
import { parseProbeOutput, type RemoteProbe } from '../../src/main/machines/remoteProbe'
import { planManagedTools, managedToolsMarker } from '../../src/main/machines/managedToolPlan'
import { planProvision } from '../../src/main/machines/provisionPlan'
import { REMOTE_CODEX_VERSION, codexEnsureScript, claudeSymlinkScript, managedToolsMarkerScript } from '../../src/main/machines/provisionSetup'
import { buildProbeCommand } from '../../src/main/machines/provisionCommands'
import type { Machine } from '@shared/machines'

const desired = { claudeSdkVersion: '0.2.141', codexVersion: '0.153.2' }

const probe = (over: Partial<RemoteProbe> = {}): RemoteProbe => ({
  node: 'v20.11.0',
  platform: 'linux',
  arch: 'x64',
  abi: '115',
  server: '0.8.52',
  bridge: null,
  claudeBin: '/home/u/.switchboard-server/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
  claudeVersion: '0.2.141',
  codexBin: '/home/u/.switchboard-server/node_modules/@openai/codex/bin/codex.js',
  codexVersion: '0.153.2',
  tools: managedToolsMarker(desired),
  ...over,
})

describe('managedToolsMarker', () => {
  it('is derived from the pinned tool versions, not the app version', () => {
    const a = managedToolsMarker(desired)
    expect(a).toBe(managedToolsMarker({ ...desired }))
    expect(managedToolsMarker({ ...desired, codexVersion: '0.144.1' })).not.toBe(a)
    expect(managedToolsMarker({ ...desired, claudeSdkVersion: '0.2.114' })).not.toBe(a)
  })

  it('is shell-safe, since it is written and compared inside a remote script', () => {
    expect(managedToolsMarker(desired)).toMatch(/^[A-Za-z0-9._-]+$/)
  })
})

describe('planManagedTools', () => {
  it('is satisfied when the marker matches AND both executables resolve', () => {
    const plan = planManagedTools(probe(), desired)
    expect(plan.satisfied).toBe(true)
    expect(plan.claude.action).toBe('ok')
    expect(plan.codex.action).toBe('ok')
  })

  it('repairs a ready server whose managed claude link is missing', () => {
    // The exact hole: `plan.action === 'ready'` used to return before
    // claudeSymlinkScript ever ran, so this state never healed.
    const plan = planManagedTools(probe({ claudeBin: null }), desired)
    expect(plan.claude.action).toBe('repair')
    expect(plan.satisfied).toBe(false)
    expect(plan.codex.action).toBe('ok')
  })

  it('upgrades a codex CLI pinned to an older version', () => {
    const plan = planManagedTools(
      probe({ codexVersion: '0.144.1', tools: managedToolsMarker({ ...desired, codexVersion: '0.144.1' }) }),
      desired,
    )
    expect(plan.codex.action).toBe('upgrade')
    expect(plan.codex.reason).toContain('0.144.1')
    expect(plan.codex.reason).toContain('0.153.2')
    expect(plan.satisfied).toBe(false)
  })

  it('installs a tool the remote has never had', () => {
    const plan = planManagedTools(probe({ codexBin: null, codexVersion: null, tools: null }), desired)
    expect(plan.codex.action).toBe('install')
    expect(plan.satisfied).toBe(false)
  })

  it('does NOT trust a matching marker over a broken executable', () => {
    // A marker is a cheap short-circuit, not proof. An interrupted npm prune or
    // a manually deleted symlink leaves the marker current and the tool gone.
    const plan = planManagedTools(probe({ codexBin: null }), desired)
    expect(plan.codex.action).toBe('repair')
    expect(plan.satisfied).toBe(false)
  })

  it('ignores the server marker entirely - tool state is tracked on its own', () => {
    const stale = planManagedTools(probe({ server: '0.1.0' }), desired)
    const ahead = planManagedTools(probe({ server: '99.0.0' }), desired)
    const none = planManagedTools(probe({ server: null }), desired)
    expect([stale.satisfied, ahead.satisfied, none.satisfied]).toEqual([true, true, true])
  })

  it('is orthogonal to planProvision: a ready SERVER can still need tool work', () => {
    const p = probe({ claudeBin: null })
    expect(planProvision(p, '0.8.52').action).toBe('ready')
    expect(planManagedTools(p, desired).satisfied).toBe(false)
  })

  it('claude and codex are decided separately', () => {
    const plan = planManagedTools(probe({ claudeVersion: '0.2.100', codexBin: null }), desired)
    expect(plan.claude.action).toBe('upgrade')
    expect(plan.codex.action).toBe('repair')
  })
})

describe('pinned tool versions stay reproducible', () => {
  it('codex is pinned to an exact version, never a floating range or latest', () => {
    expect(REMOTE_CODEX_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(REMOTE_CODEX_VERSION).not.toContain('latest')
  })

  it('the codex install command carries that exact pin', () => {
    expect(codexEnsureScript(REMOTE_CODEX_VERSION)).toContain(`@openai/codex@${REMOTE_CODEX_VERSION}`)
  })

  it('the codex ensure script compares the INSTALLED version, not mere presence', () => {
    // `test -x` alone is what let 0.144.1 sit on a remote forever.
    const script = codexEnsureScript(REMOTE_CODEX_VERSION)
    expect(script).toContain('@openai/codex/package.json')
    expect(script).toContain(REMOTE_CODEX_VERSION)
    expect(script).toMatch(/\.local\/bin\/codex/)
  })

  it('the claude link script proves the link is executable before succeeding', () => {
    expect(claudeSymlinkScript()).toContain('test -x "$HOME/.local/bin/claude"')
  })

  it('the tools marker is written as its own last step', () => {
    const script = managedToolsMarkerScript('abc123')
    expect(script).toContain('abc123')
    expect(script).toContain('tools-version')
  })
})

describe('claude vs codex are repaired differently, on purpose', () => {
  it('claude is a relink of the SDK-bundled CLI - never its own npm install', () => {
    // The CLI comes from `@anthropic-ai/claude-agent-sdk`, which the uploaded
    // bundle is compiled against, so its version is the app's dependency and is
    // installed by the server's own `npm install`. Installing it separately
    // could desync the CLI from the SDK the bundle links.
    const script = claudeSymlinkScript()
    expect(script).not.toContain('npm install')
    expect(script).toContain('claude-agent-sdk-linux-')
    expect(script).toContain('ln -sfn')
  })

  it('codex is independently pinned and may install itself', () => {
    // Codex is a standalone binary spoken to over app-server JSON-RPC, not
    // linked into the bundle, so it carries its own pin and its own install.
    const script = codexEnsureScript(REMOTE_CODEX_VERSION)
    expect(script).toContain('npm install')
    expect(script).toContain(`@openai/codex@${REMOTE_CODEX_VERSION}`)
  })

  it('a broken claude does not block a codex repair, or vice versa', () => {
    const p = planManagedTools(probe({ claudeBin: null, codexVersion: '0.144.1' }), desired)
    expect(p.claude.action).toBe('repair')
    expect(p.codex.action).toBe('upgrade')
    // Both are actionable in the same pass; neither decision reads the other.
    expect(p.satisfied).toBe(false)
  })

  it('claude tracks the app SDK version while codex tracks the standalone pin', () => {
    // Bumping the app's SDK dep must re-provision claude; bumping the codex pin
    // must re-provision codex. Each version lands in a different marker.
    const bumpedSdk = { ...desired, claudeSdkVersion: '0.2.200' }
    expect(planManagedTools(probe(), bumpedSdk).claude.action).toBe('upgrade')
    expect(planManagedTools(probe(), bumpedSdk).codex.action).toBe('ok')
    expect(managedToolsMarker(bumpedSdk)).not.toBe(managedToolsMarker(desired))
  })
})

describe('the ssh probe reports resolved executables and versions', () => {
  const decode = (remote: string): string => {
    const m = remote.match(/printf %s '([A-Za-z0-9+/=]+)'/)
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : remote
  }
  const machine: Machine = {
    id: 'm1', name: 'prod', sshAlias: 'prod-vm', sshHost: 'h', sshUser: 'u',
    sshPort: 22, remoteUser: null, sortOrder: 0, createdAt: 0, updatedAt: 0,
  }

  it('parses the new executable/version fields', () => {
    const line = JSON.stringify({
      node: 'v20.11.0', platform: 'linux', arch: 'x64', abi: '115', server: '0.8.52',
      claudeBin: '/home/u/.local/bin/claude', claudeVersion: '0.2.141',
      codexBin: '/home/u/.local/bin/codex', codexVersion: '0.153.2', tools: 'abc123',
    })
    const parsed = parseProbeOutput(line)
    expect(parsed.claudeBin).toBe('/home/u/.local/bin/claude')
    expect(parsed.claudeVersion).toBe('0.2.141')
    expect(parsed.codexBin).toBe('/home/u/.local/bin/codex')
    expect(parsed.codexVersion).toBe('0.153.2')
    expect(parsed.tools).toBe('abc123')
  })

  it('nulls the tool fields for an older remote that does not report them', () => {
    const legacy = JSON.stringify({ node: 'v20.11.0', server: '0.8.52' })
    const parsed = parseProbeOutput(legacy)
    expect(parsed.claudeBin).toBeNull()
    expect(parsed.codexVersion).toBeNull()
    expect(parsed.tools).toBeNull()
    // ...which makes the tool plan do the work rather than skip it.
    expect(planManagedTools(parsed, desired).satisfied).toBe(false)
  })

  it('resolves the managed links rather than just testing existence', () => {
    const source = decode(buildProbeCommand(machine).args.at(-1) as string)
    expect(source).toContain('realpathSync')
    expect(source).toContain('.local/bin/claude')
    expect(source).toContain('.local/bin/codex')
    expect(source).toContain('@openai/codex/package.json')
    expect(source).toContain('claude-agent-sdk/package.json')
    expect(source).toContain('tools-version')
  })

  it('the probe source still has no double quotes (it rides inside node -e "...")', () => {
    const remoteCmd = decode(buildProbeCommand(machine).args.at(-1) as string)
    const marker = 'node -e "'
    const start = remoteCmd.indexOf(marker) + marker.length
    const inner = remoteCmd.slice(start, remoteCmd.lastIndexOf('"'))
    expect(inner).not.toContain('"')
  })
})
