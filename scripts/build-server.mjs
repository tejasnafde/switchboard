/**
 * Bundle the headless backend (src/server/index.ts → out/server/index.cjs).
 * Everything is bundled EXCEPT the native modules (which ship a .node binary
 * that can't be bundled), electron (never loaded headless - the runtime shim
 * keeps it out of the graph), and the Claude Agent SDK. The SDK self-locates
 * its platform CLI via `fileURLToPath(import.meta.url)`, which esbuild rewrites
 * to `undefined` when inlined - so it MUST stay an external node_module on the
 * VM (installed via provisionSetup). See REMOTE_NPM_DEPS below.
 */
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

export const REMOTE_NATIVE_DEPS = ['better-sqlite3', 'node-pty']
// Pure-JS but external (see header): must stay an on-disk module on the VM.
export const REMOTE_NPM_DEPS = ['@anthropic-ai/claude-agent-sdk']

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'out/server/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: [...REMOTE_NATIVE_DEPS, ...REMOTE_NPM_DEPS, 'electron'],
  alias: { '@shared': resolve('src/shared') },
  // Lets the running server report its own version so the client's health
  // probe (connectDeps.ts waitForHealth) can detect a stale/lingering
  // process that survived past a fresh deploy.
  define: { __SERVER_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
})
