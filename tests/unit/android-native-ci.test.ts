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

  test('builds a signed AAB with the exported upload keystore instead of EAS', () => {
    const workflow = readFileSync(releaseWorkflowPath, 'utf8')

    expect(workflow).toContain('working-directory: apps/android')
    expect(workflow).toContain("java-version: '17'")
    expect(workflow).toContain('ANDROID_KEYSTORE_BASE64')
    expect(workflow).toContain('SWITCHBOARD_ANDROID_KEYSTORE_PATH')
    expect(workflow).toContain(
      './gradlew --no-daemon testDebugUnitTest lintDebug bundleRelease compileDebugAndroidTestKotlin',
    )
    expect(workflow).not.toMatch(/assembleRelease|eas build|expo-github-action|EXPO_TOKEN/i)
  })

  test('cannot publish merely because main changed', () => {
    const workflow = readFileSync(releaseWorkflowPath, 'utf8')

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('  push:\n')
  })

  test('verifies the AAB before uploading it to a Play test track', () => {
    const workflow = readFileSync(releaseWorkflowPath, 'utf8')
    const parsed = parseYaml(workflow) as any
    const steps = parsed.jobs.release.steps as any[]
    const verify = steps.findIndex((step) => String(step.run ?? '').includes('verify-android-apk.mjs --aab'))
    const upload = steps.findIndex((step) => String(step.uses ?? '').startsWith('r0adkll/upload-google-play@'))

    expect(verify).toBeGreaterThanOrEqual(0)
    expect(upload).toBeGreaterThan(verify)
    expect(steps[upload].uses).toMatch(/@[0-9a-f]{40}$/)
    expect(steps[upload].with.serviceAccountJsonPlainText).toBe('${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}')
    expect(steps[upload].with.packageName).toBe('app.tn07.switchboard')
    expect(steps[upload].if).toBe('inputs.play')
    expect(parsed.on.workflow_dispatch.inputs.track.options).toEqual(['internal', 'alpha', 'beta'])
    expect(parsed.on.workflow_dispatch.inputs.play.default).toBe(true)
    expect(parsed.permissions).toEqual({ contents: 'read' })
    expect(parsed.jobs.release.permissions).toBeUndefined()
    expect(workflow).toContain('sha256sum --check')
  })

  test('gives Play the native debug symbols and, once R8 runs, its mapping', () => {
    const workflow = readFileSync(releaseWorkflowPath, 'utf8')
    const steps = (parseYaml(workflow) as any).jobs.release.steps as any[]
    const symbols = steps.findIndex((step) => String(step.run ?? '').includes('com.android.tools.build.debugsymbols/'))
    const upload = steps.findIndex((step) => String(step.uses ?? '').startsWith('r0adkll/upload-google-play@'))

    expect(readFileSync(androidBuildPath, 'utf8')).toContain('ndk.debugSymbolLevel = "SYMBOL_TABLE"')
    expect(symbols).toBeGreaterThanOrEqual(0)
    expect(steps[symbols].run).toContain("grep -q ' \\.symtab '")
    expect(steps[symbols].run).toContain('exit "$MISSING"')
    expect(upload).toBeGreaterThan(symbols)
    expect(steps[upload].with.mappingFile).toBe('${{ env.MAPPING_FILE }}')
    expect(workflow).toContain('app/build/outputs/mapping/release/mapping.txt')
  })

  test('installs the NDK that build.gradle.kts pins before every release build', () => {
    expect(readFileSync(androidBuildPath, 'utf8')).toMatch(/^ {4}ndkVersion = "\d+\.\d+\.\d+"$/m)
    for (const [path, job] of [
      [releaseWorkflowPath, 'release'],
      [workflowPath, 'build'],
    ]) {
      const steps = (parseYaml(readFileSync(path, 'utf8')) as any).jobs[job].steps as any[]
      const install = steps.findIndex((step) =>
        String(step.run ?? '').includes('sdkmanager --install "ndk;$NDK_VERSION"'),
      )
      const build = steps.findIndex((step) => /bundleRelease|assembleRelease/.test(String(step.run ?? '')))
      expect(install, path).toBeGreaterThanOrEqual(0)
      expect(build, path).toBeGreaterThan(install)
    }
  })

  test('publishes a sideload APK only on request, built from the verified AAB and verified itself', () => {
    const parsed = parseYaml(readFileSync(releaseWorkflowPath, 'utf8')) as any
    const steps = parsed.jobs.release.steps as any[]
    const index = (needle: string) => steps.findIndex((step) => String(step.run ?? '').includes(needle))
    const verifyAab = index('verify-android-apk.mjs --aab')
    const buildApk = index('build-apks --mode=universal')
    const verifyApk = index('verify-android-apk.mjs --apk "$RELEASE_APK" --checksum')

    expect(parsed.on.workflow_dispatch.inputs.apk.default).toBe(false)
    expect(buildApk).toBeGreaterThan(verifyAab)
    expect(verifyApk).toBeGreaterThan(buildApk)
    for (const step of [steps[buildApk], steps[verifyApk]]) expect(step.if).toBe('inputs.apk')
    expect(steps[buildApk].run).toContain('--ks-pass="file:')
    expect(steps[buildApk].run).not.toMatch(/pass:\$/)

    const keepApk = steps.find((step) => String(step.with?.name ?? '').endsWith('-apk'))
    expect(keepApk.if).toBe('inputs.apk')
    expect(keepApk.with.name).toBe('switchboard-${{ steps.version.outputs.version }}-apk')

    const publish = parsed.jobs['publish-apk']
    expect(publish.needs).toBe('release')
    expect(publish.if).toBe('inputs.apk')
    expect(publish.permissions).toEqual({ contents: 'write' })
    expect(publish.defaults.run['working-directory']).toBe('.')
    expect(publish.steps[0].with.name).toBe('switchboard-${{ needs.release.outputs.version }}-apk')
    const create = publish.steps.map((step: any) => String(step.run ?? '')).join('\n')
    expect(create.indexOf('sha256sum --check')).toBeGreaterThanOrEqual(0)
    expect(create.indexOf('gh release create "mobile-v$VERSION"')).toBeGreaterThan(create.indexOf('sha256sum --check'))
    // A mobile release marked latest would hide the desktop release from electron-updater.
    expect(create).toContain('--latest=false')
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
