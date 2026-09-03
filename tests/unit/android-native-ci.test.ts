import { readFileSync } from 'node:fs'
import { load as parseYaml } from 'js-yaml'
import { describe, expect, test } from 'vitest'

const workflowPath = '.github/workflows/android-native-ci.yml'
const releaseWorkflowPath = '.github/workflows/mobile-release.yml'
const androidBuildPath = 'apps/android/app/build.gradle.kts'
const appContractPath = 'apps/android/app/src/main/java/app/switchboard/mobile/AppContract.kt'
const switchboardAppPath = 'apps/android/app/src/main/java/app/switchboard/mobile/ui/SwitchboardApp.kt'
const otaWorkflowPath = '.github/workflows/mobile-ota.yml'

describe('native Android non-publishing CI', () => {
  test('uses Java 17 and runs every required Android build gate', () => {
    const workflow = readFileSync(workflowPath, 'utf8')

    expect(workflow).toContain("java-version: '17'")
    expect(workflow).toContain(
      './gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug assembleRelease compileDebugAndroidTestKotlin',
    )
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

  describe('instrumented job', () => {
    const loadInstrumentedJob = () => {
      const workflow = parseYaml(readFileSync(workflowPath, 'utf8')) as any
      const job = workflow.jobs?.instrumented
      expect(job, 'jobs.instrumented must exist').toBeDefined()
      expect(Array.isArray(job.steps)).toBe(true)
      return job
    }

    test('is non-blocking pending demonstrated stability', () => {
      const job = loadInstrumentedJob()

      expect(job['continue-on-error']).toBe(true)
    })

    test('scopes the emulator run to ThreadScreenRegressionTest only', () => {
      const job = loadInstrumentedJob()
      const runStep = job.steps.find(
        (step: any) => typeof step.uses === 'string' && step.uses.startsWith('reactivecircus/android-emulator-runner'),
      )

      expect(runStep, 'expected a reactivecircus/android-emulator-runner step').toBeDefined()
      expect(typeof runStep.with?.script).toBe('string')
      expect(runStep.with.script).toContain('connectedDebugAndroidTest')
      expect(runStep.with.script).toContain(
        '-Pandroid.testInstrumentationRunnerArguments.class=app.switchboard.mobile.ui.thread.ThreadScreenRegressionTest',
      )
    })

    test('uploads connected test reports on both success and failure', () => {
      const job = loadInstrumentedJob()
      const uploadStep = job.steps.find(
        (step: any) => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact'),
      )

      expect(uploadStep, 'expected an actions/upload-artifact step').toBeDefined()
      expect(uploadStep.if).toBe('always()')
      expect(uploadStep.with?.path).toContain('androidTests/connected')
      expect(uploadStep.with?.path).toContain('androidTest-results/connected')
    })

    test('runs after the emulator step, not before it', () => {
      const job = loadInstrumentedJob()
      const runIndex = job.steps.findIndex(
        (step: any) => typeof step.uses === 'string' && step.uses.startsWith('reactivecircus/android-emulator-runner'),
      )
      const uploadIndex = job.steps.findIndex(
        (step: any) => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact'),
      )

      expect(runIndex).toBeGreaterThanOrEqual(0)
      expect(uploadIndex).toBeGreaterThan(runIndex)
    })
  })
})

describe('native Android publishing lane', () => {
  test('uses Gradle package metadata as the only Android version source', () => {
    const contract = readFileSync(appContractPath, 'utf8')
    const app = readFileSync(switchboardAppPath, 'utf8')

    expect(contract).not.toMatch(/const val VERSION_(?:NAME|CODE)/)
    expect(app).toContain('BuildConfig.VERSION_NAME')
    expect(app).not.toContain('AppContract.VERSION_NAME')
  })

  test('builds the Kotlin app with the exported production keystore instead of EAS', () => {
    const workflow = readFileSync(releaseWorkflowPath, 'utf8')

    expect(workflow).toContain("working-directory: apps/android")
    expect(workflow).toContain("java-version: '17'")
    expect(workflow).toContain('ANDROID_KEYSTORE_BASE64')
    expect(workflow).toContain('SWITCHBOARD_ANDROID_KEYSTORE_PATH')
    expect(workflow).toContain(
      './gradlew --no-daemon testDebugUnitTest lintDebug assembleRelease compileDebugAndroidTestKotlin',
    )
    expect(workflow).not.toMatch(/eas build|expo-github-action|EXPO_TOKEN/i)
  })

  test('cannot publish the incomplete native port merely because main changed', () => {
    const workflow = readFileSync(releaseWorkflowPath, 'utf8')

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('  push:\n')
  })

  test('strictly verifies and publishes the canonical APK plus checksum', () => {
    const workflow = readFileSync(releaseWorkflowPath, 'utf8')

    expect(workflow).toContain('verify-android-apk.mjs --apk "$RELEASE_APK" --checksum "$CHECKSUM_FILE"')
    expect(workflow).toContain('sha256sum')
    expect(workflow).toContain('switchboard-${{ steps.version.outputs.version }}.apk.sha256')
    expect(workflow).toContain('gh release create')
    expect(workflow).toContain('--latest=false')
  })

  test('rejects a tag-version mismatch or a non-increasing Android version code', () => {
    const workflow = readFileSync(releaseWorkflowPath, 'utf8')

    expect(workflow).toContain('APK_VERSION_NAME')
    expect(workflow).toContain('PREVIOUS_VERSION_CODE')
    expect(workflow).toContain('NEW_VERSION_CODE <= PREVIOUS_VERSION_CODE')
    expect(workflow).toContain('verify-android-apk.mjs --identity-only --apk "$RUNNER_TEMP/switchboard-previous.apk"')
    expect(workflow).toContain('Release already exists; increment apps/android versionName and versionCode')
    expect(workflow).not.toContain("echo \"exists=true\" >> \"$GITHUB_OUTPUT\"")
  })

  test('release signing is opt-in locally but complete credentials are mandatory once selected', () => {
    const build = readFileSync(androidBuildPath, 'utf8')

    expect(build).toContain('SWITCHBOARD_ANDROID_KEYSTORE_PATH')
    expect(build).toContain('SWITCHBOARD_ANDROID_KEYSTORE_PASSWORD')
    expect(build).toContain('SWITCHBOARD_ANDROID_KEY_ALIAS')
    expect(build).toContain('SWITCHBOARD_ANDROID_KEY_PASSWORD')
    expect(build).not.toContain('storePassword = "')
  })

  test('keeps Expo OTA explicitly iOS-only after the native Android cutover', () => {
    const workflow = readFileSync(otaWorkflowPath, 'utf8')

    expect(workflow).toContain('eas update --platform ios')
  })
})
