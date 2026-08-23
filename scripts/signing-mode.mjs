import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const REQUIRED = {
  mac: [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ],
  windows: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'],
}

export function classifySigningEnvironment(platform, environment) {
  const required = REQUIRED[platform]
  if (!required) throw new Error(`Unsupported signing platform: ${platform}`)
  const present = required.filter((name) => {
    const value = environment[name]
    return typeof value === 'string' && value.trim().length > 0
  })
  if (present.length === 0) return { mode: 'unsigned', missing: [] }
  const missing = required.filter((name) => !present.includes(name))
  return missing.length > 0
    ? { mode: 'invalid', missing }
    : { mode: 'signed', missing: [] }
}

function run() {
  const platform = process.argv[2]
  const result = classifySigningEnvironment(platform, process.env)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\n`)
  }
  if (result.mode === 'invalid') {
    console.error(`Incomplete ${platform} signing configuration; missing: ${result.missing.join(', ')}`)
    process.exitCode = 1
    return
  }
  console.log(`${platform} signing mode: ${result.mode}`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run()
