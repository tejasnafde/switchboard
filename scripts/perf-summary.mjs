import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { transform } from 'esbuild'

const source = await readFile(new URL('../src/shared/perf-summary.ts', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'ts', format: 'esm' })
const { parsePerfLogs, summarizePerf } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const dir = join(homedir(), 'Library/Application Support/switchboard/logs')
let files = process.argv.slice(2)
if (!files.length) {
  const candidates = await Promise.all((await readdir(dir)).filter((name) => /^switchboard-.*\.log$/.test(name)).map(async (name) => {
    const path = join(dir, name)
    return { path, mtime: (await stat(path)).mtimeMs }
  }))
  files = candidates.sort((a, b) => b.mtime - a.mtime).slice(0, 3).map((file) => file.path)
}
const entries = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).flatMap((content) => parsePerfLogs(content, (message) => console.warn(`[perf:summary] ${message}`)))
for (const span of summarizePerf(entries)) {
  console.log(`${span.name}: count=${span.count} p50=${span.p50}ms p90=${span.p90}ms max=${span.max}ms`)
  for (const entry of span.worst) console.log(`  ${entry.durationMs}ms ${JSON.stringify(entry.fields)}`)
}
if (!entries.length) console.log('No performance spans found.')
