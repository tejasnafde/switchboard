import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export async function planDesktopRelease(version, api, expectedSha = '') {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) || version.includes('\n')) {
    throw new Error('Choose a version in X.Y.Z form, without a v prefix')
  }
  const { tag_name: latest } = await api('releases/latest')
  const previous = /^v([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(latest)
  if (!previous) throw new Error('Latest release does not have a desktop version')
  const parts = version.split('.').map(BigInt)
  const old = previous.slice(1).map(BigInt)
  const difference = parts.findIndex((part, index) => part !== old[index])
  if (difference === -1 || parts[difference] < old[difference]) {
    throw new Error(`Choose a version newer than ${latest}`)
  }
  const { sha } = await api('commits/main')
  if (expectedSha && expectedSha !== sha) throw new Error('Main changed since the reviewed dry run; run a new dry run')
  const tag = `v${version}`
  const tags = await api(`git/matching-refs/tags/${tag}`)
  if (tags.some(({ ref }) => ref === `refs/tags/${tag}`)) throw new Error(`Tag ${tag} already exists`)
  const { workflow_runs: runs } = await api(
    `actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&status=success&per_page=100`,
  )
  if (
    !runs.some(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === 'main' &&
        run.event === 'push' &&
        run.status === 'completed' &&
        run.conclusion === 'success',
    )
  ) {
    throw new Error(`Main CI has not succeeded on ${sha}; retry after it passes`)
  }
  return { sha, version, tag }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (
    process.env.DRY_RUN !== 'true' &&
    (process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_SHA !== process.env.EXPECTED_SHA ||
      !/^[a-f0-9]{40}$/.test(process.env.EXPECTED_SHA ?? ''))
  ) {
    throw new Error('A real release requires workflow ref main and expected_sha from the reviewed dry run')
  }
  const plan = await planDesktopRelease(
    process.env.VERSION,
    async (path) =>
      JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/${path}`], { encoding: 'utf8' })),
    process.env.EXPECTED_SHA,
  )
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(plan)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  )
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `Desktop release plan: **${plan.tag}** at \`${plan.sha}\`. Main push CI passed. Workflow: ${process.env.GITHUB_REF} at ${process.env.GITHUB_SHA}. Branch dry runs validate proposed workflow code; repeat on main before a real release. Dry run: **${process.env.DRY_RUN}**.\n`,
  )
}
