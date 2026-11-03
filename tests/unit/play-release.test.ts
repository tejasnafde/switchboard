import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { allocateAndroidRelease, promoteAndroidRelease, rewriteAndroidVersion } from '../../scripts/play-release.mjs'

const gradle = 'android {\n defaultConfig {\n versionCode = 27\n versionName = "0.5.25"\n }\n}'
function play({
  bundles = [28],
  apks = [29],
  internal = ['30'],
  production = ['26'],
  status = 'completed',
  fail = '',
} = {}) {
  const writes: [string, string, unknown?][] = []
  return {
    writes,
    api: async (method: string, path: string, body?: unknown) => {
      writes.push([method, path, body])
      if (path === '' && method === 'POST') return { id: 'edit1' }
      if (path.endsWith(fail) && fail) throw new Error('API unavailable')
      if (path === '/edit1/bundles') return { bundles: bundles.map((versionCode) => ({ versionCode })) }
      if (path === '/edit1/apks') return { apks: apks.map((versionCode) => ({ versionCode })) }
      const track = (versionCodes: string[], name: string) => ({
        releases: [{ versionCodes, status, name, releaseNotes: [{ language: 'en-US', text: 'Tested changes' }] }],
      })
      if (path === '/edit1/tracks') return { tracks: [track(internal, 'internal'), track(production, 'production')] }
      if (path === '/edit1/tracks/internal') return track(internal, 'internal')
      if (path === '/edit1/tracks/production' && method === 'GET') return track(production, 'production')
      if (method === 'DELETE' || method === 'PUT' || path.endsWith(':commit')) return {}
      throw new Error(`Unexpected ${method} ${path}`)
    },
  }
}

describe('Android release automation', () => {
  it('never prints malformed credential contents on authentication failure', () => {
    const secret = 'private-fixture-never-log-this'
    const result = spawnSync(process.execPath, ['scripts/play-release.mjs', 'allocate'], {
      encoding: 'utf8',
      env: { ...process.env, PLAY_SERVICE_ACCOUNT_JSON: secret, VERSION_NAME: '0.5.26' },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Could not authenticate PLAY_SERVICE_ACCOUNT_JSON')
    expect(result.stderr + result.stdout).not.toContain(secret)
  })
  it('allocates above every bundle, APK, track and repository version and discards its edit', async () => {
    const p = play()
    expect(await allocateAndroidRelease('0.5.26', gradle, p.api)).toEqual({
      versionName: '0.5.26',
      versionCode: 31,
      playMaximum: 30,
    })
    expect(p.writes.at(-1)).toEqual(['DELETE', '/edit1', undefined])
    expect(p.writes.some(([method]) => method === 'PUT')).toBe(false)
  })
  it('keeps repository versionCodes monotonic when Play is behind', async () => {
    expect(
      (
        await allocateAndroidRelease(
          '0.5.26',
          gradle,
          play({ bundles: [], apks: [], internal: [], production: [] }).api,
        )
      ).versionCode,
    ).toBe(28)
  })
  it.each(['0.5.25', '0.5.24', '0.4.99', 'v0.5.26', '1.2.3\n', '1.2.3;bad'])(
    'rejects invalid or non-increasing versionName %s',
    async (name) => {
      const p = play()
      await expect(allocateAndroidRelease(name, gradle, p.api)).rejects.toThrow('version')
      expect(p.writes).toEqual([])
    },
  )
  it('discards its edit on an inventory read failure', async () => {
    const p = play({ fail: '/bundles' })
    await expect(allocateAndroidRelease('0.5.26', gradle, p.api)).rejects.toThrow('API unavailable')
    expect(p.writes.at(-1)).toEqual(['DELETE', '/edit1', undefined])
  })
  it('fails closed on malformed Play version codes', async () => {
    await expect(allocateAndroidRelease('0.5.26', gradle, play({ internal: ['oops'] }).api)).rejects.toThrow(
      'versionCode',
    )
  })
  it('rewrites only the canonical Gradle version pair', () => {
    expect(rewriteAndroidVersion(gradle, '0.5.26', 31)).toBe(gradle.replace('27', '31').replace('0.5.25', '0.5.26'))
    expect(() => rewriteAndroidVersion('no version here', '0.5.26', 31)).toThrow('Gradle')
  })
  it('does not rewrite a version mentioned in a comment', () => {
    const source = '// old versionCode = 26, versionName = "0.5.24"\n' + gradle
    expect(rewriteAndroidVersion(source, '0.5.26', 31)).toBe(
      source
        .replace('versionCode = 27', 'versionCode = 31')
        .replace('versionName = "0.5.25"', 'versionName = "0.5.26"'),
    )
  })
  it('defaults promotion to a dry run with no track update or commit', async () => {
    const p = play()
    expect(await promoteAndroidRelease('30', p.api)).toMatchObject({
      versionCodes: ['30'],
      status: 'completed',
      releaseNotes: [{ language: 'en-US', text: 'Tested changes' }],
    })
    expect(p.writes.filter(([method, path]) => method === 'PUT' || path.endsWith(':commit'))).toEqual([])
    expect(p.writes.at(-1)).toEqual(['DELETE', '/edit1', undefined])
  })
  it('promotes just the selected completed internal build and retains its notes', async () => {
    const p = play({ internal: ['30', '31'] })
    const release = await promoteAndroidRelease('30', p.api, false)
    expect(p.writes).toContainEqual(['PUT', '/edit1/tracks/production', { track: 'production', releases: [release] }])
    expect(p.writes.at(-1)).toEqual(['POST', '/edit1:commit', {}])
  })
  it.each([{ internal: ['29'] }, { status: 'draft' }, { production: ['31'] }, { production: ['30'] }])(
    'refuses absent, untested or non-increasing promotion %j',
    async (options) => {
      const p = play(options)
      await expect(promoteAndroidRelease('30', p.api, false)).rejects.toThrow()
      expect(p.writes.filter(([method, path]) => method === 'PUT' || path.endsWith(':commit'))).toEqual([])
      expect(p.writes.at(-1)).toEqual(['DELETE', '/edit1', undefined])
    },
  )
})
