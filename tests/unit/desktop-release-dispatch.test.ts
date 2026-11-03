import { describe, expect, it } from 'vitest'
import { planDesktopRelease } from '../../scripts/desktop-release.mjs'

const sha = 'a'.repeat(40)
function github({
  tags = [],
  runs = [],
  latest = 'v0.9.127',
}: { tags?: unknown[]; runs?: unknown[]; latest?: string } = {}) {
  const calls: string[] = []
  return {
    calls,
    api: async (path: string) => {
      calls.push(path)
      if (path === 'releases/latest') return { tag_name: latest }
      if (path === 'commits/main') return { sha }
      if (path.startsWith('git/matching-refs/')) return tags
      if (path.startsWith('actions/workflows/')) return { workflow_runs: runs }
      throw new Error(`Unexpected API request: ${path}`)
    },
  }
}
const success = { head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' }

describe('desktop release dispatch', () => {
  it('pins main once and requires successful main push CI on that exact SHA', async () => {
    const gh = github({ runs: [success] })
    expect(await planDesktopRelease('0.9.128', gh.api)).toEqual({ sha, version: '0.9.128', tag: 'v0.9.128' })
    expect(gh.calls.filter((path) => path === 'commits/main')).toHaveLength(1)
    expect(gh.calls.some((path) => path.includes(`head_sha=${sha}`))).toBe(true)
  })
  it.each(['v0.9.128', '1.2', '1.2.3; bad', '01.2.3', '1.2.3\n'])(
    'refuses invalid version %j before API access',
    async (version) => {
      const gh = github()
      await expect(planDesktopRelease(version, gh.api)).rejects.toThrow('version')
      expect(gh.calls).toEqual([])
    },
  )
  it('refuses an existing exact tag', async () => {
    const gh = github({ tags: [{ ref: 'refs/tags/v0.9.128' }], runs: [success] })
    await expect(planDesktopRelease('0.9.128', gh.api)).rejects.toThrow('already exists')
  })
  it('allows a longer tag with the same prefix', async () => {
    const gh = github({ tags: [{ ref: 'refs/tags/v0.9.1280' }], runs: [success] })
    expect((await planDesktopRelease('0.9.128', gh.api)).sha).toBe(sha)
  })
  it.each(
    [
      [],
      [{ ...success, head_sha: 'b'.repeat(40) }],
      [{ ...success, event: 'pull_request' }],
      [{ ...success, head_branch: 'feature' }],
      [{ ...success, conclusion: 'failure' }],
      [{ ...success, status: 'in_progress' }],
    ].map((runs) => ({ runs })),
  )('refuses missing or unrelated successful CI: %j', async ({ runs }) => {
    await expect(planDesktopRelease('0.9.128', github({ runs }).api)).rejects.toThrow('CI')
  })
  it('rejects main moving since the reviewed dry run', async () => {
    await expect(planDesktopRelease('0.9.128', github({ runs: [success] }).api, 'b'.repeat(40))).rejects.toThrow(
      'changed',
    )
  })
  it('accepts the exact SHA from the reviewed dry run', async () => {
    expect((await planDesktopRelease('0.9.128', github({ runs: [success] }).api, sha)).sha).toBe(sha)
  })
  it.each(['v0.9.128', 'v0.10.0', 'v1.0.0'])('refuses a non-increasing version against %s', async (latest) => {
    await expect(planDesktopRelease('0.9.128', github({ runs: [success], latest }).api)).rejects.toThrow('newer')
  })
  it('fails closed on API failure', async () => {
    await expect(
      planDesktopRelease('0.9.128', async () => {
        throw new Error('API unavailable')
      }),
    ).rejects.toThrow('API unavailable')
  })
})
