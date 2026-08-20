import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SURFACES = [
  'desktop',
  'reactNativeIos',
  'nativeAndroid',
  'sharedBackendApi',
  'storageDataMigration',
  'updateRelease',
]

const PRODUCT_PATHS = [
  'src/main/',
  'src/preload/',
  'src/renderer/',
  'src/server/',
  'src/shared/',
  'apps/mobile/',
  'apps/android/',
  'resources/',
]

const PRODUCT_FILES = new Set([
  'electron-builder.yml',
  'app-update.yml',
  'package.json',
  'apps/mobile/app.json',
  'apps/mobile/eas.json',
  'apps/mobile/package.json',
  'apps/android/build.gradle.kts',
  'apps/android/settings.gradle.kts',
])

const MANIFEST_DIRECTORY = 'docs/feature-parity'
const MANIFEST_PATTERN = /^docs\/feature-parity\/[^/]+\.json$/

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)
}

export function validateFeatureParityManifest(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest must be an object']
  }

  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (!nonEmptyString(manifest.feature)) errors.push('feature is required')
  if (!nonEmptyString(manifest.summary)) errors.push('summary is required')

  if (!manifest.surfaces || typeof manifest.surfaces !== 'object') {
    errors.push('surfaces is required')
  } else {
    for (const surfaceName of SURFACES) {
      const surface = manifest.surfaces[surfaceName]
      if (!surface || typeof surface !== 'object') {
        errors.push(`surfaces.${surfaceName} is required`)
        continue
      }

      if (!['implemented', 'not_applicable', 'staged'].includes(surface.status)) {
        errors.push(
          `surfaces.${surfaceName}.status must be implemented, not_applicable, or staged`,
        )
        continue
      }

      if (surface.status === 'implemented' && !nonEmptyStringArray(surface.evidence)) {
        errors.push(
          `surfaces.${surfaceName}.evidence must contain at least one item for implemented`,
        )
      }
      if (surface.status === 'not_applicable' && !nonEmptyString(surface.reason)) {
        errors.push(`surfaces.${surfaceName}.reason is required for not_applicable`)
      }
      if (surface.status === 'staged') {
        if (!nonEmptyString(surface.flag)) {
          errors.push(`surfaces.${surfaceName}.flag is required for staged`)
        }
        if (!nonEmptyString(surface.followUpRelease)) {
          errors.push(`surfaces.${surfaceName}.followUpRelease is required for staged`)
        }
      }
    }
  }

  const verification = manifest.verification
  if (!verification || typeof verification !== 'object') {
    errors.push('verification is required')
  } else {
    if (!nonEmptyStringArray(verification.automated)) {
      errors.push('verification.automated must contain at least one item')
    }
    for (const field of ['hardware', 'notExercised']) {
      if (!Array.isArray(verification[field]) || !verification[field].every(nonEmptyString)) {
        errors.push(`verification.${field} must be an array of non-empty strings`)
      }
    }
  }

  return errors
}

export function requiresFeatureParityManifest(changedFiles) {
  return changedFiles.some((path) => {
    const normalized = path.replaceAll('\\', '/')
    if (normalized.startsWith('tests/') || normalized.startsWith('docs/')) return false
    return PRODUCT_FILES.has(normalized) || PRODUCT_PATHS.some((prefix) => normalized.startsWith(prefix))
  })
}

function listJsonFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listJsonFiles(path) : entry.name.endsWith('.json') ? [path] : []
  })
}

function changedFilesSince(repoRoot, base) {
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean)
}

function parseArgs(args) {
  const result = { all: false, base: '', files: [] }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--all') result.all = true
    else if (arg === '--base') result.base = args[++index] ?? ''
    else if (arg === '--files') result.files = args.slice(index + 1)
  }
  return result
}

export function runFeatureParityValidation({ repoRoot, all = false, base = '', files = [] }) {
  const changedFiles = files.length > 0 ? files : all ? [] : changedFilesSince(repoRoot, base)
  const manifestFiles = all
    ? listJsonFiles(join(repoRoot, MANIFEST_DIRECTORY))
    : changedFiles.filter((path) => MANIFEST_PATTERN.test(path)).map((path) => join(repoRoot, path))
  const failures = []

  if (!all && requiresFeatureParityManifest(changedFiles) && manifestFiles.length === 0) {
    failures.push(
      `Behavior-bearing changes require a changed ${MANIFEST_DIRECTORY}/<feature>.json manifest.`,
    )
  }

  for (const manifestFile of manifestFiles) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    } catch (error) {
      failures.push(`${relative(repoRoot, manifestFile)}: invalid JSON (${error.message})`)
      continue
    }
    for (const error of validateFeatureParityManifest(manifest)) {
      failures.push(`${relative(repoRoot, manifestFile)}: ${error}`)
    }
  }

  return failures
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
const modulePath = fileURLToPath(import.meta.url)
if (invokedPath === modulePath) {
  const repoRoot = resolve(dirname(modulePath), '..')
  const args = parseArgs(process.argv.slice(2))
  if (!args.all && args.files.length === 0 && !args.base) {
    console.error('Usage: validate-feature-parity.mjs --all | --base <git-ref> | --files <paths...>')
    process.exit(2)
  }

  const failures = runFeatureParityValidation({ repoRoot, ...args })
  if (failures.length > 0) {
    console.error(`Feature parity policy failed:\n- ${failures.join('\n- ')}`)
    process.exit(1)
  }
  console.log('Feature parity policy passed.')
}
