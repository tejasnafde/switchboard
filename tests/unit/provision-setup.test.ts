/** Remote setup payload: the package.json + install script we drop on a VM. */
import { describe, it, expect } from 'vitest'
import { remotePackageJson, remoteInstallScript, claudeSymlinkScript, codexEnsureScript, versionMarkerScript, bridgeSeedScript, bridgeMarker, codeServerEnsureScript, REMOTE_CODEX_VERSION, REMOTE_SERVER_DIR } from '../../src/main/machines/provisionSetup'
import { BRIDGE_EXTENSION_DIRNAME } from '../../src/main/ide/code-server-manager'

describe('remotePackageJson', () => {
  const pkg = remotePackageJson('0.4.16', '12.9.0', '0.2.114')

  it('stamps the app version and is private', () => {
    expect(pkg.version).toBe('0.4.16')
    expect(pkg.private).toBe(true)
  })

  it('pins better-sqlite3 to the app build version', () => {
    expect(pkg.dependencies['better-sqlite3']).toBe('12.9.0')
  })

  it('installs the Claude SDK as a real dep (it self-locates its CLI, cannot be bundled)', () => {
    expect(pkg.dependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.2.114')
  })

  it('installs a pinned Codex CLI whose optional dependency supplies the remote Linux binary', () => {
    expect(pkg.dependencies['@openai/codex']).toBe(REMOTE_CODEX_VERSION)
  })

  it('aliases node-pty to the multiarch fork (ships linux prebuilds)', () => {
    expect(pkg.dependencies['node-pty']).toMatch(/^npm:@homebridge\/node-pty-prebuilt-multiarch@/)
  })

  it('points main at the uploaded bundle', () => {
    expect(pkg.main).toBe('index.cjs')
  })
})

describe('remoteInstallScript', () => {
  const script = remoteInstallScript()

  it('creates the server dir and installs without dev deps or audit noise', () => {
    expect(script).toContain(REMOTE_SERVER_DIR)
    expect(script).toMatch(/npm install/)
    expect(script).toContain('--omit=dev')
  })

  it('does not write the version marker (that is its own final step, see versionMarkerScript)', () => {
    expect(script).not.toContain('> version')
  })

  it('chains steps with && so a failure aborts the rest', () => {
    expect(script).toContain('&&')
  })
})

describe('versionMarkerScript', () => {
  const script = versionMarkerScript('0.4.16')

  it('writes the app version into the marker file in the server dir', () => {
    expect(script).toContain(REMOTE_SERVER_DIR)
    expect(script).toContain('printf %s 0.4.16 > version')
  })

  it('chains cd with && so a missing dir never writes a stray marker', () => {
    expect(script).toMatch(/cd .* && printf/)
  })
})

describe('codeServerEnsureScript manifest clear', () => {
  const script = codeServerEnsureScript('4.127.0')

  it('clears extensions.json on EVERY connect, after the extension install', () => {
    // --install-extension rewrites extensions.json, and a manifest that omits
    // sb-bridge marks it removed - the extension sits on disk and never
    // activates. This lives here, not in the seed, because the seed is gated on
    // the probe marker and so does not run on a steady-state connect.
    const installAt = script.indexOf('--install-extension')
    const clearAt = script.indexOf('rm -f "$D/ide-extensions/extensions.json" "$D/ide-extensions/.obsolete"')
    expect(clearAt).toBeGreaterThan(-1)
    expect(clearAt).toBeGreaterThan(installAt)
  })
})

describe('bridgeMarker', () => {
  const files = [{ relPath: 'a.js', base64: 'YQ==' }]

  it('is stable for the same payload and changes with it', () => {
    expect(bridgeMarker(files)).toBe(bridgeMarker([...files]))
    expect(bridgeMarker([{ relPath: 'a.js', base64: 'Yg==' }])).not.toBe(bridgeMarker(files))
  })

  it('changes when only a path changes, so a renamed file re-seeds', () => {
    expect(bridgeMarker([{ relPath: 'b.js', base64: 'YQ==' }])).not.toBe(bridgeMarker(files))
  })

  it('matches the marker the seed script writes and compares (that is the gate)', () => {
    expect(bridgeSeedScript(files)).toContain(bridgeMarker(files))
  })
})

describe('claudeSymlinkScript', () => {
  const script = claudeSymlinkScript()

  it('links the SDK-bundled claude CLI into ~/.local/bin', () => {
    expect(script).toContain('mkdir -p "$HOME/.local/bin"')
    expect(script).toContain('ln -sfn "$BIN" "$HOME/.local/bin/claude"')
  })

  it('resolves the SDK platform package under the server node_modules', () => {
    expect(script).toContain(`${REMOTE_SERVER_DIR}/node_modules/@anthropic-ai/claude-agent-sdk-linux-$ARCH/claude`)
  })

  it('maps uname arch to the SDK package suffix (aarch64 -> arm64, x86_64 -> x64)', () => {
    expect(script).toContain("uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/'")
  })

  it('prefers the glibc variant and falls back to musl', () => {
    const glibcAt = script.indexOf('claude-agent-sdk-linux-$ARCH/claude')
    const muslAt = script.indexOf('claude-agent-sdk-linux-$ARCH-musl/claude')
    expect(glibcAt).toBeGreaterThan(-1)
    expect(muslAt).toBeGreaterThan(glibcAt)
    expect(script).toMatch(/if \[ -f "\$GLIBC" \]; then BIN="\$GLIBC"; elif \[ -f "\$MUSL" \]; then BIN="\$MUSL"/)
  })

  it('exits non-zero when neither variant is installed so the caller can log the miss', () => {
    expect(script).toContain('exit 1')
  })
})

describe('codexEnsureScript', () => {
  const script = codexEnsureScript()

  it('installs the pinned CLI only when the remote binary is absent', () => {
    expect(script).toContain(`@openai/codex@${REMOTE_CODEX_VERSION}`)
    expect(script).toContain('BIN="$D/node_modules/.bin/codex"')
    expect(script).toContain('if [ -x "$BIN" ]')
  })

  it('links Codex into the runtime user PATH', () => {
    expect(script).toContain('mkdir -p "$HOME/.local/bin"')
    expect(script).toContain('ln -sfn "$BIN" "$HOME/.local/bin/codex"')
  })
})

/**
 * bridgeSeedScript installs sb-bridge onto a REMOTE code-server's
 * --extensions-dir. Without it the VM's workbench has no bridge extension, so
 * every in-workbench keybinding is swallowed by the guest with nothing to
 * forward it to the desktop (the cmd+shift+E "toggle on worked, toggle off did
 * nothing" report).
 */
describe('bridgeSeedScript', () => {
  const files = [
    { relPath: 'package.json', base64: 'cGtn' },
    { relPath: 'extension.js', base64: 'ZXh0' },
    { relPath: 'themes/switchboard-charcoal-color-theme.json', base64: 'dGhtZQ==' },
  ]
  const script = bridgeSeedScript(files)
  const extDir = `$D/ide-extensions/${BRIDGE_EXTENSION_DIRNAME}`

  it('installs under the same folder name the local seeder uses', () => {
    // Both sides must agree: VS Code resolves extensions by <publisher>.<name>-<version>.
    expect(script).toContain(extDir)
  })

  it('writes every bundled file, decoding from base64', () => {
    for (const f of files) {
      expect(script).toContain(`printf %s '${f.base64}' | base64 -d > "${extDir}/${f.relPath}"`)
    }
  })

  it('creates the parent directory of a nested payload', () => {
    expect(script).toContain(`"${extDir}/themes"`)
  })

  it('short-circuits when the payload marker already matches', () => {
    const guardAt = script.indexOf('.sb-marker" 2>/dev/null)"')
    expect(guardAt).toBeGreaterThan(-1)
    expect(script).toContain('exit 0')
    // The guard must precede any destructive step.
    expect(guardAt).toBeLessThan(script.indexOf('rm -rf'))
  })

  it('clears the manifest BEFORE the guard, so the fast path still clears it', () => {
    // The Jupyter install is a separate retried step whose --install-extension
    // rewrites extensions.json and marks sb-bridge removed. If the clear sat
    // after the short-circuit, that would strand the remote bridge-less.
    expect(script.indexOf('rm -f "$D/ide-extensions/extensions.json"')).toBeLessThan(
      script.indexOf('.sb-marker" 2>/dev/null)"'),
    )
  })

  it('keys the marker on payload content, not the app version, so an edited extension re-seeds', () => {
    const edited = bridgeSeedScript([{ relPath: 'package.json', base64: 'ZGlmZmVyZW50' }])
    const markerOf = (s: string): string => s.match(/\.sb-marker" 2>\/dev\/null\)" = "([a-f0-9]+)"/)![1]
    expect(markerOf(edited)).not.toBe(markerOf(script))
    // Same payload must be stable, or every connect would re-seed.
    expect(markerOf(bridgeSeedScript(files))).toBe(markerOf(script))
  })

  it('replaces the directory wholesale so a dropped file cannot linger', () => {
    expect(script).toContain(`rm -rf "${extDir}"`)
  })

  it('writes the marker LAST so an interrupted seed re-runs', () => {
    const markerAt = script.lastIndexOf(`> "${extDir}/.sb-marker"`)
    expect(markerAt).toBeGreaterThan(-1)
    expect(markerAt).toBeGreaterThan(script.lastIndexOf('base64 -d'))
  })

  it('targets the same server dir the bootstrap points code-server at', () => {
    expect(script).toContain(`D=${REMOTE_SERVER_DIR}`)
  })

  it('refuses to build a script with nothing to seed', () => {
    expect(() => bridgeSeedScript([])).toThrow(/no extension files/)
  })
})
