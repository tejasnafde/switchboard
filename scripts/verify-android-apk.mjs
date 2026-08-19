import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CANONICAL_ANDROID_PACKAGE = 'app.switchboard.mobile'
export const CANONICAL_SIGNER_SHA256 =
  'BC:81:1E:37:12:C2:D5:7F:2B:6E:BD:A5:43:92:E6:2E:BD:2A:77:34:53:E5:0F:B3:75:E1:10:2D:B9:01:A8:F6'
export const MINIMUM_NATIVE_VERSION_NAME = '0.5.0'
export const MINIMUM_NATIVE_VERSION_CODE = 2

function normalizeSha256(value) {
  const compact = value.replace(/[^a-fA-F0-9]/g, '').toUpperCase()
  if (!/^[A-F0-9]{64}$/.test(compact)) throw new Error('expected a 64-character SHA-256 digest')
  return compact
}

function fingerprint(value) {
  return normalizeSha256(value).match(/.{2}/g).join(':')
}

function quotedField(line, field) {
  return line.match(new RegExp(`${field}='([^']*)'`))?.[1]
}

export function parseAaptBadging(output) {
  const packageLine = output.split(/\r?\n/).find((line) => line.startsWith('package:'))
  if (!packageLine) throw new Error('aapt output is missing package metadata')

  const packageName = quotedField(packageLine, 'name')
  const versionCodeText = quotedField(packageLine, 'versionCode')
  const versionName = quotedField(packageLine, 'versionName')
  if (!packageName) throw new Error('aapt package metadata is missing name')
  if (!versionCodeText || !/^\d+$/.test(versionCodeText)) {
    throw new Error('aapt package metadata is missing a numeric versionCode')
  }
  if (!versionName) throw new Error('aapt package metadata is missing versionName')

  return { packageName, versionCode: Number(versionCodeText), versionName }
}

export function parseApkSignerOutput(output) {
  const matches = output.matchAll(
    /(?:Signer #\d+|V\d+(?:\.\d+)? Signer:)\s*certificate SHA-256 digest:\s*([^\s]+)/gi,
  )
  const signers = [...new Set([...matches].map((match) => fingerprint(match[1])))]
  if (signers.length === 0) throw new Error('apksigner output contains no signer SHA-256 digest')
  return signers
}

export function parseChecksumMetadata(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length !== 1) throw new Error('checksum metadata must contain exactly one entry')

  const match = lines[0].match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
  if (!match) throw new Error('checksum metadata must use sha256sum format')
  return { sha256: normalizeSha256(match[1]), filename: match[2] }
}

function compareVersionNames(left, right) {
  const parse = (value) => {
    if (!/^\d+(?:\.\d+)*$/.test(value)) throw new Error(`versionName must be numeric: ${value}`)
    return value.split('.').map(Number)
  }
  const a = parse(left)
  const b = parse(right)
  const count = Math.max(a.length, b.length)
  for (let i = 0; i < count; i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export function verifyApkEvidence(evidence) {
  const errors = []
  verifyMetadata(evidence, errors)

  if (evidence.signerSha256.length !== 1) {
    errors.push(`APK must have exactly one signer, got ${evidence.signerSha256.length}`)
  } else if (fingerprint(evidence.signerSha256[0]) !== CANONICAL_SIGNER_SHA256) {
    errors.push(`signer must be ${CANONICAL_SIGNER_SHA256}, got ${evidence.signerSha256[0]}`)
  }

  const actualSha256 = normalizeSha256(evidence.actualSha256)
  if (normalizeSha256(evidence.checksum.sha256) !== actualSha256) {
    errors.push('checksum metadata does not match the APK bytes')
  }
  if (evidence.checksum.filename !== evidence.apkFilename) {
    errors.push(`checksum metadata names ${evidence.checksum.filename}, expected ${evidence.apkFilename}`)
  }

  throwVerificationErrors(errors)

  return {
    packageName: evidence.packageName,
    versionCode: evidence.versionCode,
    versionName: evidence.versionName,
    signerSha256: CANONICAL_SIGNER_SHA256,
    sha256: actualSha256,
  }
}

function verifyMetadata(evidence, errors) {
  if (evidence.packageName !== CANONICAL_ANDROID_PACKAGE) {
    errors.push(`package must be ${CANONICAL_ANDROID_PACKAGE}, got ${evidence.packageName}`)
  }
  if (!Number.isSafeInteger(evidence.versionCode) || evidence.versionCode < MINIMUM_NATIVE_VERSION_CODE) {
    errors.push(`versionCode must be at least ${MINIMUM_NATIVE_VERSION_CODE}, got ${evidence.versionCode}`)
  }
  if (compareVersionNames(evidence.versionName, MINIMUM_NATIVE_VERSION_NAME) < 0) {
    errors.push(`versionName must be at least ${MINIMUM_NATIVE_VERSION_NAME}, got ${evidence.versionName}`)
  }
}

function throwVerificationErrors(errors) {
  if (errors.length > 0) throw new Error(`Android APK verification failed:\n- ${errors.join('\n- ')}`)
}

function verifyMetadataEvidence(evidence) {
  const errors = []
  verifyMetadata(evidence, errors)
  throwVerificationErrors(errors)
  return evidence
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()
}

function runTool(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error)
    throw new Error(`${command} failed: ${detail}`)
  }
}

function parseArguments(argv) {
  const options = { metadataOnly: false, apk: null, checksum: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--metadata-only') {
      options.metadataOnly = true
    } else if (arg === '--apk') {
      options.apk = argv[++i] ?? null
    } else if (arg === '--checksum') {
      options.checksum = argv[++i] ?? null
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!options.apk) throw new Error('--apk is required')
  if (!options.metadataOnly && !options.checksum) {
    throw new Error('--checksum is required in strict mode')
  }
  return options
}

function runCli(argv) {
  const options = parseArguments(argv)
  const apkPath = resolve(options.apk)
  if (!existsSync(apkPath)) throw new Error(`APK does not exist: ${apkPath}`)

  const aapt = process.env.AAPT2 || 'aapt2'
  const metadata = parseAaptBadging(runTool(aapt, ['dump', 'badging', apkPath]))
  verifyMetadataEvidence(metadata)
  const actualSha256 = sha256File(apkPath)

  if (options.metadataOnly) {
    process.stdout.write(
      `Verified Android APK metadata: ${metadata.packageName} ${metadata.versionName} (${metadata.versionCode}) ${actualSha256}\n`,
    )
    return
  }

  const checksumPath = resolve(options.checksum)
  if (!existsSync(checksumPath)) throw new Error(`checksum metadata does not exist: ${checksumPath}`)
  const apksigner = process.env.APKSIGNER || 'apksigner'
  const evidence = verifyApkEvidence({
    ...metadata,
    signerSha256: parseApkSignerOutput(
      runTool(apksigner, ['verify', '--verbose', '--print-certs', apkPath]),
    ),
    actualSha256,
    checksum: parseChecksumMetadata(readFileSync(checksumPath, 'utf8')),
    apkFilename: basename(apkPath),
  })
  process.stdout.write(
    `Verified Android release APK: ${evidence.packageName} ${evidence.versionName} (${evidence.versionCode}) ${evidence.sha256}\n`,
  )
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
