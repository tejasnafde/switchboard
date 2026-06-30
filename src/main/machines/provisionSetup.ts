/**
 * The payload we drop on a remote to run the backend there: a package.json and
 * an install script. We rely on npm's own prebuilt resolution rather than
 * fetching binaries ourselves - `better-sqlite3` pulls a prebuild via
 * prebuild-install, and `node-pty` is aliased to the multiarch fork, which
 * bundles linux/darwin/win32 prebuilds. So `npm install` needs node + npm on
 * the VM but no compiler for the common triples.
 */
export { REMOTE_SERVER_DIR } from './provisionCommands'
import { REMOTE_SERVER_DIR } from './provisionCommands'

/**
 * node-pty has no linux prebuilt; this fork ships glibc+musl linux (plus
 * darwin/win32) prebuilds and is API-compatible with the spawn/onData/onExit/
 * write/resize/kill subset we use. Bump + validate against a real VM if the
 * upstream node-pty API we touch ever moves past what the fork tracks.
 */
const REMOTE_NODE_PTY = 'npm:@homebridge/node-pty-prebuilt-multiarch@^0.12.0'

export interface RemotePackageJson {
  name: string
  version: string
  private: true
  main: string
  dependencies: Record<string, string>
}

export function remotePackageJson(appVersion: string, betterSqliteVersion: string): RemotePackageJson {
  return {
    name: 'switchboard-server',
    version: appVersion,
    private: true,
    main: 'index.cjs',
    dependencies: {
      'better-sqlite3': betterSqliteVersion,
      'node-pty': REMOTE_NODE_PTY,
    },
  }
}

/**
 * Shell run over ssh after the bundle + package.json are uploaded. The version
 * marker is written last so a partial install never reads as `ready` to the
 * probe (see planProvision).
 */
export function remoteInstallScript(appVersion: string): string {
  return [
    `cd ${REMOTE_SERVER_DIR}`,
    'npm install --omit=dev --no-audit --no-fund',
    `printf %s ${appVersion} > version`,
  ].join(' && ')
}
