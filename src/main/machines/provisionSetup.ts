/** The package.json + install script we drop on a VM to run the backend there. */
export { REMOTE_SERVER_DIR } from './provisionCommands'
import { REMOTE_SERVER_DIR } from './provisionCommands'

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
      // Kept out of the bundle (self-locates its CLI via import.meta.url), so
      // it has to be a real install on the VM; npm pulls the matching
      // platform CLI package via its optionalDependencies.
      '@anthropic-ai/claude-agent-sdk': claudeSdkVersion,
    },
  }
}

// Marker written last so a half-finished install never probes as ready.
export function remoteInstallScript(appVersion: string): string {
  return [
    `cd ${REMOTE_SERVER_DIR}`,
    'npm install --omit=dev --no-audit --no-fund',
    `printf %s ${appVersion} > version`,
  ].join(' && ')
}
