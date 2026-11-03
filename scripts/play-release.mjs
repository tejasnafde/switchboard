import { createSign } from 'node:crypto'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
function versionCode(value) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2100000000) {
    throw new Error('Invalid Play versionCode')
  }
  return Number(value)
}
function nativeVersion(gradle) {
  const codes = [...gradle.matchAll(/^\s*versionCode = ([0-9]+)$/gm)]
  const names = [...gradle.matchAll(/^\s*versionName = "([^"]+)"$/gm)]
  if (codes.length !== 1 || names.length !== 1) throw new Error('Expected one canonical Gradle version pair')
  return { code: versionCode(codes[0][1]), name: names[0][1] }
}
export function rewriteAndroidVersion(gradle, name, code) {
  nativeVersion(gradle)
  if (!versionPattern.test(name) || name.includes('\n')) throw new Error('Invalid versionName')
  versionCode(code)
  return gradle
    .replace(/^(\s*versionCode = )[0-9]+$/m, (_, prefix) => `${prefix}${code}`)
    .replace(/^(\s*versionName = ")[^"]+"$/m, (_, prefix) => `${prefix}${name}"`)
}
async function usingEdit(api, work) {
  const { id } = await api('POST', '', {})
  if (!id) throw new Error('Play returned no edit id')
  const path = `/${encodeURIComponent(id)}`
  let commitAttempted = false
  let workFailed = false
  try {
    return await work(path, async () => {
      commitAttempted = true
      await api('POST', `${path}:commit`, {})
    })
  } catch (error) {
    workFailed = true
    throw error
  } finally {
    if (!commitAttempted) {
      try {
        await api('DELETE', path)
      } catch (error) {
        if (!workFailed) throw error
        console.error('Could not discard the Play edit after the original failure')
      }
    }
  }
}
function trackCodes(track) {
  return (track.releases ?? []).flatMap((release) => release.versionCodes ?? []).map(versionCode)
}
export async function allocateAndroidRelease(name, gradle, api) {
  const current = nativeVersion(gradle)
  if (!versionPattern.test(name) || name.includes('\n')) throw new Error('Choose versionName in X.Y.Z form')
  const parts = name.split('.').map(Number)
  const old = current.name.split('.').map(Number)
  const index = parts.findIndex((part, i) => part !== old[i])
  if (index === -1 || parts[index] < old[index])
    throw new Error('Choose a versionName newer than the repository version')
  return usingEdit(api, async (path) => {
    const [bundles, apks, tracks] = await Promise.all([
      api('GET', `${path}/bundles`),
      api('GET', `${path}/apks`),
      api('GET', `${path}/tracks`),
    ])
    const codes = [
      ...(bundles.bundles ?? []).map((item) => versionCode(item.versionCode)),
      ...(apks.apks ?? []).map((item) => versionCode(item.versionCode)),
      ...(tracks.tracks ?? []).flatMap(trackCodes),
    ]
    const playMaximum = Math.max(0, ...codes)
    return { versionName: name, versionCode: versionCode(Math.max(current.code, playMaximum) + 1), playMaximum }
  })
}
export async function promoteAndroidRelease(code, api, dryRun = true) {
  const selected = String(versionCode(code))
  return usingEdit(api, async (path, commit) => {
    const [internal, production] = await Promise.all([
      api('GET', `${path}/tracks/internal`),
      api('GET', `${path}/tracks/production`),
    ])
    const release = internal.releases?.find(
      (item) => item.status === 'completed' && item.versionCodes?.includes(selected),
    )
    if (!release) throw new Error('Selected versionCode is not a completed internal release')
    if (trackCodes(production).some((value) => value >= Number(selected)))
      throw new Error('Production already has this or a newer versionCode')
    const next = {
      name: release.name,
      versionCodes: [selected],
      status: 'completed',
      releaseNotes: release.releaseNotes ?? [],
    }
    if (!dryRun) {
      await api('PUT', `${path}/tracks/production`, { track: 'production', releases: [next] })
      await commit()
    }
    return next
  })
}
async function playApi() {
  let token
  try {
    const key = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON)
    const now = Math.floor(Date.now() / 1000)
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const data = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 600,
    })}`
    const assertion = `${data}.${createSign('RSA-SHA256').update(data).sign(key.private_key, 'base64url')}`
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    })
    if (!response.ok) throw new Error('OAuth failed')
    token = (await response.json()).access_token
    if (!token) throw new Error('No access token')
  } catch {
    throw new Error('Could not authenticate PLAY_SERVICE_ACCOUNT_JSON; check the configured secret')
  }
  return async (method, path, body) => {
    const response = await fetch(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/app.tn07.switchboard/edits${path}`,
      {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    )
    if (!response.ok) throw new Error(`Play ${method} ${path}: HTTP ${response.status}`)
    const text = await response.text()
    return text ? JSON.parse(text) : {}
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2]
  const file = 'apps/android/app/build.gradle.kts'
  if (mode === 'set-version' || mode === 'check-version') {
    const source = readFileSync(file, 'utf8')
    const updated = rewriteAndroidVersion(source, process.env.VERSION_NAME, process.env.VERSION_CODE)
    if (mode === 'check-version' && source !== updated)
      throw new Error('Merged native version does not match the allocated release')
    if (mode === 'set-version') writeFileSync(file, updated)
  } else if (mode === 'allocate') {
    const plan = await allocateAndroidRelease(process.env.VERSION_NAME, readFileSync(file, 'utf8'), await playApi())
    for (const [key, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Android plan: ${plan.versionName} (${plan.versionCode}), above Play maximum ${plan.playMaximum}. Inventory edit discarded.\n`,
    )
  } else if (mode === 'promote') {
    const dryRun = process.env.DRY_RUN !== 'false'
    if (!dryRun && (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.TESTED !== 'true')) {
      throw new Error('Production promotion requires main and explicit confirmation that this versionCode was tested')
    }
    const release = await promoteAndroidRelease(process.env.VERSION_CODE, await playApi(), dryRun)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${dryRun ? 'Dry run, would promote' : 'Promoted'} internal versionCode ${release.versionCodes[0]} to production. ${dryRun ? 'No track update or commit was sent.' : 'Full rollout committed.'}\n`,
    )
  } else {
    throw new Error('Choose allocate, set-version, check-version or promote')
  }
}
