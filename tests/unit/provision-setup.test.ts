/** Remote setup payload: the package.json + install script we drop on a VM. */
import { describe, it, expect } from 'vitest'
import { remotePackageJson, remoteInstallScript, claudeSymlinkScript, versionMarkerScript, REMOTE_SERVER_DIR } from '../../src/main/machines/provisionSetup'

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

describe('claudeSymlinkScript', () => {
  const script = claudeSymlinkScript()

  it('links the SDK-bundled claude CLI into ~/.local/bin', () => {
    expect(script).toContain('mkdir -p "$HOME/.local/bin"')
    expect(script).toContain('ln -sf "$BIN" "$HOME/.local/bin/claude"')
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
