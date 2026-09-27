// TEMPORARY diagnostic: launch the smoke test many times, count crashes.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const runs = Number(process.env.RUNS ?? 50)
const mode = process.env.SB_SMOKE_EXIT ?? 'exit'
const dumpRoot = resolve(process.env.DUMP_DIR ?? 'crash-dumps', mode)
mkdirSync(dumpRoot, { recursive: true })
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', SB_SMOKE_CRASH_DIR: dumpRoot }
delete env.ELECTRON_RUN_AS_NODE
const codes = {}
let fails = 0
for (let i = 0; i < runs; i++) {
  const t = Date.now()
  const r = spawnSync(electronPath, [resolve('out/main/index.js'), '--smoke-test'], { env, encoding: 'utf8', timeout: 60000 })
  const key = `${r.status}/${r.signal}`
  codes[key] = (codes[key] ?? 0) + 1
  if (r.status !== 0) { fails++; console.log(`run ${i}: FAILED status=${r.status} signal=${r.signal} ms=${Date.now() - t}\n${r.stdout}\n${r.stderr}`) }
}
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
console.log(`mode=${mode} runs=${runs} fails=${fails}`, codes)
console.log('dumps:', walk(dumpRoot).filter((f) => f.endsWith('.dmp')))
