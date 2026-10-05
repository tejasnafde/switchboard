import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { transform } from 'esbuild'

const source = (await Promise.all(['../src/shared/perf-summary.ts', '../src/main/perf-log-paths.ts'].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n')
const { code } = await transform(source, { loader: 'ts', format: 'esm' })
const { parsePerfLogs, summarizePerf, perfLogDirectories } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
let files = process.argv.slice(2)
if (!files.length) {
  const directories = [...new Set(perfLogDirectories(process.platform, homedir(), process.env))]
  const candidates = (await Promise.all(directories.map(async (dir) => {
    let names
    try {
      names = await readdir(dir)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      console.warn('[perf:summary] log directory is absent; skipping')
      return []
    }
    return Promise.all(names.filter((name) => /^switchboard-.*\.log$/.test(name)).map(async (name) => {
      const path = await realpath(join(dir, name))
      return { path, mtime: (await stat(path)).mtimeMs }
    }))
  }))).flat()
  const unique = [...new Map(candidates.map((file) => [file.path, file])).values()]
  files = unique.sort((a, b) => b.mtime - a.mtime).slice(0, 3).map((file) => file.path)
}
const entries = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).flatMap((content) => parsePerfLogs(content, (message) => console.warn(`[perf:summary] ${message}`)))
for (const span of summarizePerf(entries)) {
  console.log(`${span.name}: count=${span.count} p50=${span.p50}ms p90=${span.p90}ms max=${span.max}ms`)
  for (const entry of span.worst) console.log(`  ${entry.durationMs}ms ${JSON.stringify(entry.fields)}`)
}
if (!entries.length) console.log('No performance spans found.')
