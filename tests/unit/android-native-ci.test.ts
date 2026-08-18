import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const workflowPath = '.github/workflows/android-native-ci.yml'

describe('native Android non-publishing CI', () => {
  test('uses Java 17 and runs every required Android build gate', () => {
    const workflow = readFileSync(workflowPath, 'utf8')

    expect(workflow).toContain("java-version: '17'")
    expect(workflow).toContain('./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug assembleRelease')
  })

  test('always verifies canonical release metadata and conditionally verifies signed evidence', () => {
    const workflow = readFileSync(workflowPath, 'utf8')

    expect(workflow).toContain('verify-android-apk.mjs --metadata-only --apk')
    expect(workflow).toContain("! -name '*-unsigned.apk'")
    expect(workflow).toContain('verify-android-apk.mjs --apk "$SIGNED_APK" --checksum "$CHECKSUM_FILE"')
    expect(workflow).toContain('Signed APK is missing required checksum metadata')
  })

  test('does not publish releases or invoke EAS', () => {
    const workflow = readFileSync(workflowPath, 'utf8')

    expect(workflow).not.toMatch(/gh release|eas build|eas update|--publish/i)
  })
})
