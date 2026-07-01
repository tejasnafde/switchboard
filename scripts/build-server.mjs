/**
 * Bundle the headless backend (src/server/index.ts → out/server/index.cjs).
 * Everything is bundled EXCEPT the native modules (which ship a .node binary
 * that can't be bundled) and electron (never loaded headless - the runtime shim
 * keeps it out of the graph). So a provisioned VM only needs `better-sqlite3` +
 * `node-pty` installed; all pure-JS deps (ws, SDKs, js-yaml, ...) are inlined.
 */
import { build } from 'esbuild'
import { resolve } from 'node:path'

export const REMOTE_NATIVE_DEPS = ['better-sqlite3', 'node-pty']

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'out/server/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: [...REMOTE_NATIVE_DEPS, 'electron'],
  alias: { '@shared': resolve('src/shared') },
  logLevel: 'info',
})
