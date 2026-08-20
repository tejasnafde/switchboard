import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const manifestPath = 'apps/android/app/src/main/AndroidManifest.xml'

describe('native Android deep-link delivery', () => {
  test('reuses the single activity for warm external links', () => {
    const manifest = readFileSync(manifestPath, 'utf8')
    const mainActivity = manifest.match(
      /<activity\s+[\s\S]*?android:name="\.MainActivity"[\s\S]*?<\/activity>/,
    )?.[0]

    expect(mainActivity).toBeDefined()
    expect(mainActivity).toContain('android:launchMode="singleTask"')
  })

  test('keeps both canonical browsable schemes registered on the main activity', () => {
    const manifest = readFileSync(manifestPath, 'utf8')

    expect(manifest).toContain('<data android:scheme="switchboard" />')
    expect(manifest).toContain(
      '<data android:scheme="com.googleusercontent.apps.974343814740-be31f3e59stdql81uke54r62aodb5c7q" />',
    )
  })
})
