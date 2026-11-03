import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function planIosRelease(sha, api) {
  if (!/^[0-9a-f]{40}$/.test(sha) || sha.includes('\n')) throw new Error('Choose a full immutable main SHA')
  const main = await api('commits/main')
  const comparison = await api(`compare/${sha}...${main.sha}`)
  if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Selected SHA is not on main')
  const runs = await api(
    `actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&status=success&per_page=1`,
  )
  if (
    !runs.workflow_runs.some(
      (run) =>
        run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' && run.conclusion === 'success',
    )
  )
    throw new Error('Selected main SHA has no successful main push CI')
  return sha
}

export async function buildAndSubmitIos(sha, run, dryRun = true) {
  await run(['submit:status', '--platform', 'ios', '--profile', 'store', '--json', '--non-interactive'])
  const result = JSON.parse(
    await run([
      'build',
      '--platform',
      'ios',
      '--profile',
      'store',
      '--non-interactive',
      '--freeze-credentials',
      '--wait',
      '--json',
    ]),
  )
  const build = result.length === 1 ? result[0] : null
  if (
    !build ||
    !/^[0-9a-f-]{36}$/.test(build.id) ||
    build.status !== 'FINISHED' ||
    build.platform !== 'IOS' ||
    build.distribution !== 'STORE' ||
    build.buildProfile !== 'store' ||
    build.gitCommitHash !== sha ||
    build.app?.id !== 'efbb89d9-210f-4584-bf62-8186cd5fb476' ||
    build.appIdentifier !== 'app.tn07.switchboard' ||
    build.isForIosSimulator !== false
  )
    throw new Error('Unexpected or incomplete EAS store build; no submission was made')
  if (!dryRun)
    await run(['submit', '--platform', 'ios', '--profile', 'store', '--id', build.id, '--non-interactive', '--wait'])
  return build.id
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2]
  const sha = process.env.SOURCE_SHA
  const dryRun = process.env.DRY_RUN !== 'false'
  if (!dryRun && process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Real submission must dispatch main')
  if (mode === 'plan') {
    const api = async (path) =>
      JSON.parse(
        execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/${path}`], {
          encoding: 'utf8',
          timeout: 30_000,
        }),
      )
    await planIosRelease(sha, api)
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Pinned iOS source: ${sha}. Main push CI passed. Dry run: ${dryRun}.\n`,
    )
  } else if (mode === 'build') {
    const cwd = resolve(process.argv[3])
    const app = JSON.parse(readFileSync(resolve(cwd, 'app.json'), 'utf8')).expo
    const eas = JSON.parse(readFileSync(resolve(cwd, 'eas.json'), 'utf8'))
    if (
      app.ios.bundleIdentifier !== 'app.tn07.switchboard' ||
      app.extra.eas.projectId !== 'efbb89d9-210f-4584-bf62-8186cd5fb476' ||
      eas.build.store.distribution !== 'store' ||
      eas.submit.store.ios.ascAppId !== '6824965919'
    )
      throw new Error('Unexpected iOS store identity or profile')
    const submitConfig = iosSubmitProfile(eas, process.env)
    const easFile = resolve(cwd, 'eas.json')
    const original = readFileSync(easFile)
    const run = async (args) => {
      if (args[0] === 'submit') writeFileSync(easFile, JSON.stringify(submitConfig, null, 2) + '\n')
      try {
        return execFileSync('eas', args, {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          maxBuffer: 10 * 1024 * 1024,
          timeout: 100 * 60_000,
        })
      } catch {
        throw new Error(`EAS ${args[0]} failed; inspect its dashboard before retrying`)
      } finally {
        if (args[0] === 'submit') writeFileSync(easFile, original)
      }
    }
    const id = await buildAndSubmitIos(sha, run, dryRun)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${dryRun ? 'Dry run: built, did not submit' : 'Submitted to TestFlight'} EAS build ${id} from ${sha}. App Store review remains manual.\n`,
    )
  } else throw new Error('Choose plan or build')
}

export function iosSubmitProfile(config, env) {
  if (!env.ASC_API_KEY_PATH || !env.ASC_API_KEY_ID || !env.ASC_API_KEY_ISSUER_ID)
    throw new Error('ASC submit credentials are incomplete')
  const bound = structuredClone(config)
  Object.assign(bound.submit.store.ios, {
    ascApiKeyPath: env.ASC_API_KEY_PATH,
    ascApiKeyId: env.ASC_API_KEY_ID,
    ascApiKeyIssuerId: env.ASC_API_KEY_ISSUER_ID,
  })
  return bound
}
