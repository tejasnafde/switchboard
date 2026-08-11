/** The package.json + install script we drop on a VM to run the backend there. */
export { REMOTE_SERVER_DIR } from './provisionCommands'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { REMOTE_SERVER_DIR } from './provisionCommands'
import { JUPYTER_EXTENSION_IDS, BRIDGE_EXTENSION_DIRNAME } from '../ide/code-server-manager'

// Fork that ships the linux prebuilds upstream node-pty omits. Bump + validate
// on a VM if our node-pty API surface outgrows what the fork tracks.
const REMOTE_NODE_PTY = 'npm:@homebridge/node-pty-prebuilt-multiarch@^0.12.0'
export const REMOTE_CODEX_VERSION = '0.144.1'

export interface RemotePackageJson {
  name: string
  version: string
  private: true
  main: string
  dependencies: Record<string, string>
}

export function remotePackageJson(
  appVersion: string,
  betterSqliteVersion: string,
  claudeSdkVersion: string,
): RemotePackageJson {
  return {
    name: 'switchboard-server',
    version: appVersion,
    private: true,
    main: 'index.cjs',
    dependencies: {
      'better-sqlite3': betterSqliteVersion,
      'node-pty': REMOTE_NODE_PTY,
      // Externalized from the bundle, so it must install on the VM; npm pulls
      // the matching platform CLI via its optionalDependencies.
      '@anthropic-ai/claude-agent-sdk': claudeSdkVersion,
      '@openai/codex': REMOTE_CODEX_VERSION,
    },
  }
}

export function remoteInstallScript(): string {
  return [
    `cd ${REMOTE_SERVER_DIR}`,
    'npm install --omit=dev --no-audit --no-fund',
  ].join(' && ')
}

/** Idempotent remote code-server install: tarball once, trust-off settings,
 *  notebook extensions guarded SEPARATELY so a failed extension install is
 *  retried on the next connect instead of being masked by the existing
 *  binary. The tunnel bootstrap starts it; this only installs. */
export function codeServerEnsureScript(codeServerVersion: string): string {
  const dir = `${REMOTE_SERVER_DIR}/code-server`
  const installBinary = [
    'case "$(uname -m)" in x86_64) A=amd64 ;; aarch64|arm64) A=arm64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; esac',
    `curl -fsSL -o "$D/cs.tar.gz" "https://github.com/coder/code-server/releases/download/v${codeServerVersion}/code-server-${codeServerVersion}-linux-$A.tar.gz"`,
    `mkdir -p "${dir}" "$D/ide-data/User" "$D/ide-extensions"`,
    `tar -xzf "$D/cs.tar.gz" -C "${dir}" --strip-components=1`,
    `rm -f "$D/cs.tar.gz"`,
    // Trust prompt off (Restricted Mode blocks extensions), no welcome tab.
    `printf '%s' '{"security.workspace.trust.enabled": false, "workbench.startupEditor": "none", "telemetry.telemetryLevel": "off", "files.autoSave": "afterDelay"}' > "$D/ide-data/User/settings.json"`,
  ].join(' && ')
  const installExtensions =
    `ls "$D/ide-extensions" 2>/dev/null | grep -q "^${JUPYTER_EXTENSION_IDS[0]}-" || ` +
    `"${dir}/bin/code-server" --extensions-dir "$D/ide-extensions" --user-data-dir "$D/ide-data" ` +
    JUPYTER_EXTENSION_IDS.map((id) => `--install-extension ${id}`).join(' ')
  return [
    `D=${REMOTE_SERVER_DIR}`,
    `if [ -x "${dir}/bin/code-server" ]; then :; else ${installBinary}; fi`,
    installExtensions,
    // Clear the manifest LAST, on every connect: --install-extension above
    // rewrites extensions.json, and a manifest that omits sb-bridge marks it
    // removed - so the extension would sit on disk and never activate. Cheap
    // (no payload), and code-server rebuilds it from a folder scan on boot.
    `rm -f "$D/ide-extensions/extensions.json" "$D/ide-extensions/.obsolete"`,
  ].join(' && ')
}

/** One bundled sb-bridge file, base64'd so it survives ssh + sudo + bash. */
export interface BridgeFile {
  /** Path relative to resources/sb-bridge, POSIX separators (e.g. `themes/x.json`). */
  relPath: string
  base64: string
}

/**
 * Install the sb-bridge extension onto the remote's --extensions-dir. This is
 * the remote counterpart of seedBridgeExtension() (which cpSync's it locally):
 * without it the VM's code-server has no bridge extension at all, so nothing
 * inside the remote workbench can reach Switchboard.
 *
 * Only reached when the probe says the remote's marker differs (see
 * provisioner.ts): the payload is ~20KB and an upload to an IAP-tunneled host
 * costs ~2 minutes regardless of size, so this must not ride every connect.
 *
 * The marker is a hash of the PAYLOAD, not the app version: `seedBridgeExtension`
 * re-copies unconditionally on every local boot, so editing
 * resources/sb-bridge and reconnecting must re-seed the remote too. Keying on
 * appVersion would leave the VM on a stale extension, with no signal, until the
 * next release - the same silent no-bridge failure this whole path exists to fix.
 */
export function bridgeMarker(files: BridgeFile[]): string {
  return createHash('sha256')
    .update(files.map((f) => `${f.relPath}:${f.base64}`).join('\n'))
    .digest('hex')
    .slice(0, 16)
}

export function bridgeSeedScript(files: BridgeFile[]): string {
  if (files.length === 0) throw new Error('bridgeSeedScript: no extension files to seed')
  const extDir = `$D/ide-extensions/${BRIDGE_EXTENSION_DIRNAME}`
  const marker = bridgeMarker(files)
  // Every distinct parent dir, so nested payloads (themes/) land in place.
  const dirs = [...new Set(files.map((f) => posix.join(extDir, posix.dirname(f.relPath))))]
  return [
    `D=${REMOTE_SERVER_DIR}`,
    // Backstop for the probe-side gate in provisioner.ts: re-running this after
    // an interrupted seed must be a no-op once the payload is complete.
    `if [ "$(cat "${extDir}/.sb-marker" 2>/dev/null)" = "${marker}" ]; then exit 0; fi`,
    // Replace wholesale so a file dropped from a later build cannot linger.
    `rm -rf "${extDir}"`,
    `mkdir -p ${dirs.map((d) => `"${d}"`).join(' ')}`,
    ...files.map((f) => `printf %s '${f.base64}' | base64 -d > "${extDir}/${f.relPath}"`),
    // Marker last: an interrupted seed must re-run on the next connect.
    `printf %s '${marker}' > "${extDir}/.sb-marker"`,
  ].join(' && ')
}

/**
 * Symlink the SDK-bundled claude CLI onto PATH so remote shells can run
 * `claude` directly. npm installs exactly one platform package via the SDK's
 * optionalDependencies; prefer the glibc dir and fall back to musl, mirroring
 * findSdkClaudeBin in claude-adapter.ts (node's detect-libc misfires to musl
 * on some builds). Exits non-zero when neither variant is installed - the
 * caller treats this step as best-effort.
 */
export function claudeSymlinkScript(): string {
  const sdkDir = `${REMOTE_SERVER_DIR}/node_modules/@anthropic-ai`
  return [
    "ARCH=\"$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')\"",
    `GLIBC="${sdkDir}/claude-agent-sdk-linux-$ARCH/claude"`,
    `MUSL="${sdkDir}/claude-agent-sdk-linux-$ARCH-musl/claude"`,
    'if [ -f "$GLIBC" ]; then BIN="$GLIBC"; elif [ -f "$MUSL" ]; then BIN="$MUSL"; else echo "no bundled claude CLI for linux-$ARCH" >&2; exit 1; fi',
    'chmod +x "$BIN" 2>/dev/null || true',
    'mkdir -p "$HOME/.local/bin"',
    'ln -sf "$BIN" "$HOME/.local/bin/claude"',
  ].join('\n')
}

/** Ensure Codex exists even when the server marker predates Codex support. */
export function codexEnsureScript(): string {
  return [
    `D=${REMOTE_SERVER_DIR}`,
    'BIN="$D/node_modules/.bin/codex"',
    `if [ -x "$BIN" ]; then :; else cd "$D" && npm install --omit=dev --no-audit --no-fund @openai/codex@${REMOTE_CODEX_VERSION}; fi`,
    'test -x "$BIN"',
    'mkdir -p "$HOME/.local/bin"',
    'ln -sf "$BIN" "$HOME/.local/bin/codex"',
  ].join('\n')
}

// Marker written as its own final step so a half-finished install never
// probes as ready - keep this the LAST thing provisioning runs.
export function versionMarkerScript(appVersion: string): string {
  return `cd ${REMOTE_SERVER_DIR} && printf %s ${appVersion} > version`
}
