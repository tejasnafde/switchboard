/**
 * Bundle the headless backend (src/server/index.ts → out/server/index.cjs).
 * Everything is bundled EXCEPT the native modules (which ship a .node binary
 * that can't be bundled) and electron (never loaded headless - the runtime shim
 * keeps it out of the graph). So a provisioned VM only needs `better-sqlite3` +
 * `node-pty` installed; all pure-JS deps (ws, SDKs, js-yaml, ...) are inlined.
 */
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

export const REMOTE_NATIVE_DEPS = ['better-sqlite3', 'node-pty']

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'out/server/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: [...REMOTE_NATIVE_DEPS, 'electron'],
  alias: { '@shared': resolve('src/shared') },
  // Lets the running server report its own version so the client's health
  // probe (connectDeps.ts waitForHealth) can detect a stale/lingering
  // process that survived past a fresh deploy.
  define: { __SERVER_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
})
