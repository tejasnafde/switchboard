import { describe, expect, it } from 'vitest'
import { planIosRelease, buildAndSubmitIos, iosSubmitProfile } from '../../scripts/ios-release.mjs'

const sha = 'a'.repeat(40)
const id = '12345678-1234-1234-1234-123456789abc'
const build = {
  id,
  status: 'FINISHED',
  platform: 'IOS',
  distribution: 'STORE',
  buildProfile: 'store',
  gitCommitHash: sha,
  app: { id: 'efbb89d9-210f-4584-bf62-8186cd5fb476' },
  appIdentifier: 'app.tn07.switchboard',
  isForIosSimulator: false,
}
const api =
  (status = 'ahead', green = true) =>
  async (path: string) => {
    if (path === 'commits/main') return { sha: 'b'.repeat(40) }
    if (path.startsWith('compare/')) return { status }
    return {
      workflow_runs: green ? [{ head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'success' }] : [],
    }
  }

describe('TestFlight dispatch', () => {
  it('binds submit credentials without changing the build profile or source config', () => {
    const config = {
      build: { store: { distribution: 'store' } },
      submit: { store: { ios: { ascAppId: '6824965919', ascApiKeyPath: '$ASC_API_KEY_PATH' } } },
    }
    const env = { ASC_API_KEY_PATH: '/private/key.p8', ASC_API_KEY_ID: 'key-id', ASC_API_KEY_ISSUER_ID: 'issuer' }
    const bound = iosSubmitProfile(config, env)
    expect(bound.build).toEqual(config.build)
    expect(bound.submit.store.ios).toMatchObject({
      ascAppId: '6824965919',
      ascApiKeyPath: '/private/key.p8',
      ascApiKeyId: 'key-id',
      ascApiKeyIssuerId: 'issuer',
    })
    expect(config.submit.store.ios.ascApiKeyPath).toBe('$ASC_API_KEY_PATH')
    expect(() => iosSubmitProfile(config, {})).toThrow('credentials')
  })
  it('accepts an immutable main ancestor with successful main push CI', async () => {
    expect(await planIosRelease(sha, api())).toBe(sha)
  })
  it.each(['branch', 'a'.repeat(39), `${sha}\n`])('rejects non-SHA input %s', async (value) => {
    await expect(planIosRelease(value, api())).rejects.toThrow('SHA')
  })
  it('refuses a branch-only commit or missing successful main CI', async () => {
    await expect(planIosRelease(sha, api('diverged'))).rejects.toThrow('main')
    await expect(planIosRelease(sha, api('ahead', false))).rejects.toThrow('CI')
  })
  it('defaults to a real store build with frozen credentials and no submission', async () => {
    const calls: string[][] = []
    const run = async (args: string[]) => {
      calls.push(args)
      return args[0] === 'build' ? JSON.stringify([build]) : '{}'
    }
    expect(await buildAndSubmitIos(sha, run)).toBe(id)
    expect(calls.map((args) => args[0])).toEqual(['submit:status', 'build'])
    expect(calls[1]).toContain('--freeze-credentials')
    expect(calls[1]).not.toContain('--auto-submit')
  })
  it('submits only the exact successful build ID when deliberately enabled', async () => {
    const calls: string[][] = []
    await buildAndSubmitIos(
      sha,
      async (args: string[]) => {
        calls.push(args)
        return JSON.stringify([build])
      },
      false,
    )
    expect(calls[2]).toEqual([
      'submit',
      '--platform',
      'ios',
      '--profile',
      'store',
      '--id',
      id,
      '--non-interactive',
      '--wait',
    ])
    expect(calls[2]).not.toContain('--latest')
  })
  it.each([
    { status: 'ERRORED' },
    { gitCommitHash: 'c'.repeat(40) },
    { platform: 'ANDROID' },
    { distribution: 'INTERNAL' },
    { buildProfile: 'preview' },
    { app: { id: 'other-project' } },
    { appIdentifier: 'another.app' },
    { isForIosSimulator: true },
  ])('never submits an unexpected build %j', async (override) => {
    const calls: string[] = []
    await expect(
      buildAndSubmitIos(
        sha,
        async (args: string[]) => {
          calls.push(args[0])
          return JSON.stringify([{ ...build, ...override }])
        },
        false,
      ),
    ).rejects.toThrow('build')
    expect(calls).not.toContain('submit')
  })
  it('does not retry a build or submit whose outcome is unknown', async () => {
    const calls: string[] = []
    await expect(
      buildAndSubmitIos(
        sha,
        async (args: string[]) => {
          calls.push(args[0])
          if (args[0] === 'submit') throw new Error('timeout')
          return JSON.stringify([build])
        },
        false,
      ),
    ).rejects.toThrow('timeout')
    expect(calls).toEqual(['submit:status', 'build', 'submit'])
  })
})
