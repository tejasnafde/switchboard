/**
 * Bundle the headless backend (src/server/index.ts → out/server/index.cjs).
 * All node_modules stay external (resolved at runtime, like electron-vite's
 * main build) - native deps (better-sqlite3, node-pty) and electron included.
 * A clean bundle also proves the whole import graph is Electron-free.
 */
import { build } from 'esbuild'
import { resolve } from 'node:path'

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'out/server/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  alias: { '@shared': resolve('src/shared') },
  logLevel: 'info',
})
