/** The package.json + install script we drop on a VM to run the backend there. */
export { REMOTE_SERVER_DIR } from './provisionCommands'
import { REMOTE_SERVER_DIR } from './provisionCommands'
import { JUPYTER_EXTENSION_IDS } from '../ide/code-server-manager'

// Fork that ships the linux prebuilds upstream node-pty omits. Bump + validate
// on a VM if our node-pty API surface outgrows what the fork tracks.
const REMOTE_NODE_PTY = 'npm:@homebridge/node-pty-prebuilt-multiarch@^0.12.0'

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

// Marker written as its own final step so a half-finished install never
// probes as ready - keep this the LAST thing provisioning runs.
export function versionMarkerScript(appVersion: string): string {
  return `cd ${REMOTE_SERVER_DIR} && printf %s ${appVersion} > version`
}
