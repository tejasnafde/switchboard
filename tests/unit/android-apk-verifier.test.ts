import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  CANONICAL_ANDROID_PACKAGE,
  CANONICAL_SIGNER_SHA256,
  MINIMUM_NATIVE_VERSION_CODE,
  MINIMUM_NATIVE_VERSION_NAME,
  parseAaptBadging,
  parseApkSignerOutput,
  parseChecksumMetadata,
  parseBundleManifest,
  parseKeytoolSigners,
  verifyApkEvidence,
  verifyBundleEvidence,
} from '../../scripts/verify-android-apk.mjs'

const digest = '0'.repeat(64)
const verifierPath = resolve('scripts/verify-android-apk.mjs')
const testWithPosixToolShims = process.platform === 'win32' ? test.skip : test

function runVerifier(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [verifierPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('Android APK release verifier', () => {
  test('parses package identity and version metadata from aapt badging', () => {
    const metadata = parseAaptBadging(
      "package: name='app.switchboard.mobile' versionCode='2' versionName='0.5.0' compileSdkVersion='36'\n" +
        "sdkVersion:'24'\ntargetSdkVersion:'36'\n",
    )

    expect(metadata).toEqual({
      packageName: 'app.switchboard.mobile',
      versionCode: 2,
      versionName: '0.5.0',
    })
  })

  test('rejects incomplete aapt badging instead of inventing defaults', () => {
    expect(() => parseAaptBadging("package: name='app.switchboard.mobile' versionCode='2'\n")).toThrow('versionName')
  })

  test('normalizes the single signer SHA-256 reported by apksigner', () => {
    const signers = parseApkSignerOutput(
      'Signer #1 certificate DN: \n' +
        'Signer #1 certificate SHA-256 digest: bc811e3712c2d57f2b6ebda54392e62ebd2a773453e50fb375e1102db901a8f6\n',
    )

    expect(signers).toEqual([CANONICAL_SIGNER_SHA256])
  })

  test('parses and deduplicates build-tools 37 verbose signer output', () => {
    const compact = CANONICAL_SIGNER_SHA256.replaceAll(':', '').toLowerCase()
    const signers = parseApkSignerOutput(
      'Number of signers: 1\n' +
        `V2 Signer: certificate SHA-256 digest: ${compact}\n` +
        `V3 Signer: certificate SHA-256 digest: ${compact}\n`,
    )

    expect(signers).toEqual([CANONICAL_SIGNER_SHA256])
  })

  test('reads standard sha256sum metadata and keeps its artifact name', () => {
    expect(parseChecksumMetadata(`${digest}  switchboard-0.5.0.apk\n`)).toEqual({
      sha256: digest.toUpperCase(),
      filename: 'switchboard-0.5.0.apk',
    })
  })

  test('accepts canonical identity, version floors, signer, and checksum', () => {
    expect(
      verifyApkEvidence({
        packageName: CANONICAL_ANDROID_PACKAGE,
        versionCode: MINIMUM_NATIVE_VERSION_CODE,
        versionName: MINIMUM_NATIVE_VERSION_NAME,
        signerSha256: [CANONICAL_SIGNER_SHA256],
        actualSha256: digest,
        checksum: { sha256: digest, filename: 'switchboard-0.5.0.apk' },
        apkFilename: 'switchboard-0.5.0.apk',
      }),
    ).toEqual({
      packageName: CANONICAL_ANDROID_PACKAGE,
      versionCode: MINIMUM_NATIVE_VERSION_CODE,
      versionName: MINIMUM_NATIVE_VERSION_NAME,
      signerSha256: CANONICAL_SIGNER_SHA256,
      sha256: digest.toUpperCase(),
    })
  })

  test('rejects a parallel package even when every other field is valid', () => {
    expect(() =>
      verifyApkEvidence({
        packageName: 'app.switchboard.mobile.native.dev',
        versionCode: 2,
        versionName: '0.5.0',
        signerSha256: [CANONICAL_SIGNER_SHA256],
        actualSha256: digest,
        checksum: { sha256: digest, filename: 'switchboard-0.5.0.apk' },
        apkFilename: 'switchboard-0.5.0.apk',
      }),
    ).toThrow('package must be app.switchboard.mobile')
  })

  test('rejects version names and codes below the native upgrade floor', () => {
    expect(() =>
      verifyApkEvidence({
        packageName: CANONICAL_ANDROID_PACKAGE,
        versionCode: 1,
        versionName: '0.4.99',
        signerSha256: [CANONICAL_SIGNER_SHA256],
        actualSha256: digest,
        checksum: { sha256: digest, filename: 'switchboard-0.5.0.apk' },
        apkFilename: 'switchboard-0.5.0.apk',
      }),
    ).toThrow('versionCode must be at least 2')
  })

  test('rejects a noncanonical or multiple-signer APK', () => {
    expect(() =>
      verifyApkEvidence({
        packageName: CANONICAL_ANDROID_PACKAGE,
        versionCode: 2,
        versionName: '0.5.0',
        signerSha256: [CANONICAL_SIGNER_SHA256, 'F'.repeat(64)],
        actualSha256: digest,
        checksum: { sha256: digest, filename: 'switchboard-0.5.0.apk' },
        apkFilename: 'switchboard-0.5.0.apk',
      }),
    ).toThrow('exactly one signer')
  })

  test('rejects checksum metadata for different bytes or a different artifact', () => {
    expect(() =>
      verifyApkEvidence({
        packageName: CANONICAL_ANDROID_PACKAGE,
        versionCode: 2,
        versionName: '0.5.0',
        signerSha256: [CANONICAL_SIGNER_SHA256],
        actualSha256: digest,
        checksum: { sha256: 'F'.repeat(64), filename: 'other.apk' },
        apkFilename: 'switchboard-0.5.0.apk',
      }),
    ).toThrow('checksum')
  })

  describe('release AAB', () => {
    const manifest = (permissions: string[]) =>
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" android:compileSdkVersion="36" ' +
      'android:versionCode="21" android:versionName="0.5.19" package="app.switchboard.mobile">\n' +
      '  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/>\n' +
      permissions.map((name) => `  <uses-permission android:name="${name}"/>\n`).join('') +
      '</manifest>\n'

    test('reads identity and permissions from bundletool manifest XML', () => {
      expect(parseBundleManifest(manifest(['android.permission.INTERNET', 'android.permission.CAMERA']))).toEqual({
        packageName: 'app.switchboard.mobile',
        versionCode: 21,
        versionName: '0.5.19',
        permissions: ['android.permission.INTERNET', 'android.permission.CAMERA'],
      })
      expect(() => parseBundleManifest('<manifest package="app.switchboard.mobile">')).toThrow('versionCode')
    })

    test('reads the first certificate of each keytool signer', () => {
      const other = 'AB:'.repeat(31) + 'AB'
      const output =
        `Signer #1:\n\nCertificate #1:\n\t SHA1: 00\n\t SHA256: ${CANONICAL_SIGNER_SHA256}\n` +
        `Certificate #2:\n\t SHA256: ${other}\n`
      expect(parseKeytoolSigners(output)).toEqual([CANONICAL_SIGNER_SHA256])
      expect(parseKeytoolSigners(`${output}Signer #2:\n\t SHA256: ${other}\n`)).toHaveLength(2)
      expect(() => parseKeytoolSigners('Not a signed JAR file')).toThrow('no signer')
    })

    test('accepts the upload key and refuses REQUEST_INSTALL_PACKAGES', () => {
      const evidence = (permissions: string[]) => ({
        ...parseBundleManifest(manifest(permissions)),
        signerSha256: [CANONICAL_SIGNER_SHA256],
      })
      expect(verifyBundleEvidence(evidence(['android.permission.INTERNET'])).signerSha256).toBe(CANONICAL_SIGNER_SHA256)
      expect(() => verifyBundleEvidence(evidence(['android.permission.REQUEST_INSTALL_PACKAGES']))).toThrow(
        'bundle must not request android.permission.REQUEST_INSTALL_PACKAGES',
      )
      expect(() => verifyBundleEvidence({ ...evidence([]), signerSha256: ['F'.repeat(64)] })).toThrow('signer must be')
    })
  })

  test('strict CLI fails clearly when no APK was supplied', () => {
    const result = runVerifier([])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--apk is required')
  })

  testWithPosixToolShims('metadata-only CLI verifies an unsigned canonical release APK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-apk-verifier-'))
    try {
      const apk = join(dir, 'app-release-unsigned.apk')
      const aapt = join(dir, 'fake-aapt2')
      writeFileSync(apk, 'unsigned apk fixture')
      writeFileSync(
        aapt,
        "#!/bin/sh\nprintf \"package: name='app.switchboard.mobile' versionCode='2' versionName='0.5.0'\\n\"\n",
      )
      chmodSync(aapt, 0o755)

      const result = runVerifier(['--metadata-only', '--apk', apk], { AAPT2: aapt })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Verified Android APK metadata')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  testWithPosixToolShims('identity-only CLI verifies the canonical signer without requiring checksum metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-apk-verifier-'))
    try {
      const apk = join(dir, 'switchboard-previous.apk')
      const aapt = join(dir, 'fake-aapt2')
      const apksigner = join(dir, 'fake-apksigner')
      writeFileSync(apk, 'previous signed apk fixture')
      writeFileSync(
        aapt,
        "#!/bin/sh\nprintf \"package: name='app.switchboard.mobile' versionCode='2' versionName='0.5.0'\\n\"\n",
      )
      writeFileSync(
        apksigner,
        `#!/bin/sh\nprintf "Signer #1 certificate SHA-256 digest: ${CANONICAL_SIGNER_SHA256}\\n"\n`,
      )
      chmodSync(aapt, 0o755)
      chmodSync(apksigner, 0o755)

      const result = runVerifier(['--identity-only', '--apk', apk], {
        AAPT2: aapt,
        APKSIGNER: apksigner,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Verified Android APK identity')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  testWithPosixToolShims('identity-only CLI rejects a previous APK signed by another certificate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-apk-verifier-'))
    try {
      const apk = join(dir, 'switchboard-previous.apk')
      const aapt = join(dir, 'fake-aapt2')
      const apksigner = join(dir, 'fake-apksigner')
      writeFileSync(apk, 'previous signed apk fixture')
      writeFileSync(
        aapt,
        "#!/bin/sh\nprintf \"package: name='app.switchboard.mobile' versionCode='2' versionName='0.5.0'\\n\"\n",
      )
      writeFileSync(apksigner, `#!/bin/sh\nprintf "Signer #1 certificate SHA-256 digest: ${'F'.repeat(64)}\\n"\n`)
      chmodSync(aapt, 0o755)
      chmodSync(apksigner, 0o755)

      const result = runVerifier(['--identity-only', '--apk', apk], {
        AAPT2: aapt,
        APKSIGNER: apksigner,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('signer must be')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('strict CLI requires checksum metadata even when the APK is signed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-apk-verifier-'))
    try {
      const apk = join(dir, 'switchboard-0.5.0.apk')
      const aapt = join(dir, 'fake-aapt2')
      const apksigner = join(dir, 'fake-apksigner')
      writeFileSync(apk, 'signed apk fixture')
      writeFileSync(
        aapt,
        "#!/bin/sh\nprintf \"package: name='app.switchboard.mobile' versionCode='2' versionName='0.5.0'\\n\"\n",
      )
      writeFileSync(
        apksigner,
        `#!/bin/sh\nprintf "Signer #1 certificate SHA-256 digest: ${CANONICAL_SIGNER_SHA256}\\n"\n`,
      )
      chmodSync(aapt, 0o755)
      chmodSync(apksigner, 0o755)

      const result = runVerifier(['--apk', apk], { AAPT2: aapt, APKSIGNER: apksigner })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('--checksum is required in strict mode')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  testWithPosixToolShims('strict CLI verifies package, version, signer, and checksum together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-apk-verifier-'))
    try {
      const apk = join(dir, 'switchboard-0.5.0.apk')
      const checksum = `${apk}.sha256`
      const aapt = join(dir, 'fake-aapt2')
      const apksigner = join(dir, 'fake-apksigner')
      const bytes = 'signed apk fixture'
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      writeFileSync(apk, bytes)
      writeFileSync(checksum, `${sha256}  switchboard-0.5.0.apk\n`)
      writeFileSync(
        aapt,
        "#!/bin/sh\nprintf \"package: name='app.switchboard.mobile' versionCode='2' versionName='0.5.0'\\n\"\n",
      )
      writeFileSync(
        apksigner,
        `#!/bin/sh\nprintf "Signer #1 certificate SHA-256 digest: ${CANONICAL_SIGNER_SHA256}\\n"\n`,
      )
      chmodSync(aapt, 0o755)
      chmodSync(apksigner, 0o755)

      const result = runVerifier(['--apk', apk, '--checksum', checksum], {
        AAPT2: aapt,
        APKSIGNER: apksigner,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Verified Android release APK')
      expect(result.stdout).toContain(sha256.toUpperCase())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
