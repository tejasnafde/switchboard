#!/usr/bin/env node
/**
 * Renames TS/JS files to the repo naming convention and rewrites every
 * reference to them. Idempotent: a second run finds nothing to rename.
 *
 *   node scripts/apply-naming-convention.mjs [--dry-run]
 *
 * The rule, for code files under NAMING_SCOPES:
 *   - `PascalCase.tsx` for React components (and their `.test.tsx`)
 *   - `useThing.ts` / `useThing.tsx` for hooks
 *   - kebab-case for everything else (one lowercase word is fine)
 * Only the stem before the first dot is checked, so `foo-bar.test.ts` passes.
 *
 * References are rewritten in every tracked text file:
 *   - `oldStem.<ext>` anywhere (imports with an extension, path strings,
 *     comments, docs, workflows, package.json, feature-parity evidence)
 *   - extensionless relative / alias import specifiers in code, resolved
 *     against the tree so a bare package subpath is never touched
 *   - `…/oldStem` path fragments in non-code files (docs say `services/fuzzyScore`),
 *     and regex-escaped `…\/oldStem` ones in code (tests match import lines)
 * A bare `oldStem` with no slash and no extension is left alone: in code and
 * prose it is usually the function the file is named after.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const NAMING_SCOPES = ['src/', 'apps/mobile/src/', 'tests/', 'e2e/', 'scripts/', 'videos/']
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']
// Every alias in tsconfig*.json, electron.vite.config.ts, vitest.config.ts,
// scripts/build-server.mjs and the mobile babel/jest/metro configs.
const ALIASES = { '@shared/': 'src/shared/', '@renderer/': 'src/renderer/' }
const SKIP_TEXT = /(^|\/)package-lock\.json$/

export function toKebab(stem) {
  return stem
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

/** Expected basename for a repo-relative path, or null when it already conforms or is out of scope. */
export function expectedBasename(relPath) {
  if (!NAMING_SCOPES.some((s) => relPath.startsWith(s)) || !CODE_EXT.test(relPath)) return null
  const base = posix.basename(relPath)
  const dot = base.indexOf('.')
  const stem = base.slice(0, dot)
  const rest = base.slice(dot)
  if (/^use[A-Z][A-Za-z0-9]*$/.test(stem)) return null
  if (/^[A-Z][A-Za-z0-9]*$/.test(stem) && rest.endsWith('.tsx')) return null
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem)) return null
  return toKebab(stem) + rest
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 })
export const trackedFiles = () => git('ls-files', '-z').split('\0').filter(Boolean)

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function plan(files) {
  const renames = []
  for (const from of files) {
    const name = expectedBasename(from)
    if (name) renames.push({ from, to: posix.join(posix.dirname(from), name) })
  }
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]))
  const targets = new Set()
  const problems = []
  for (const { from, to } of renames) {
    if (from === to) problems.push(`${from} has no conforming name, rename it by hand`)
    const clash = lower.get(to.toLowerCase())
    if (clash && clash !== from) problems.push(`${from} -> ${to} collides with ${clash}`)
    if (targets.has(to.toLowerCase())) problems.push(`two files rename to ${to}`)
    targets.add(to.toLowerCase())
  }
  return { renames, problems }
}

/** Replaces `oldStem.ext` and `/oldStem` path fragments with the kebab stem. */
export function rewriteMentions(text, stems, isCode) {
  if (stems.size === 0) return text
  const alt = [...stems].sort((a, b) => b.length - a.length).map(escapeRe).join('|')
  text = text.replace(
    new RegExp(`(?<![\\w@-])(${alt})((?:\\.[a-z0-9]+)*\\.(?:tsx?|jsx?|mjs|cjs))(?![\\w-])`, 'g'),
    (_, stem, ext) => toKebab(stem) + ext,
  )
  // In code only a regex-escaped fragment (`services\/fooBar'`); plain ones are specifiers.
  const slash = isCode ? '\\\\/' : '/'
  text = text.replace(new RegExp(`(?<=${slash})(${alt})(?![\\w.-])`, 'g'), (_, stem) => toKebab(stem))
  return text
}

/** Rewrites extensionless relative/alias specifiers in a code file that resolve to a renamed file. */
export function rewriteSpecifiers(text, file, oldPaths) {
  return text.replace(/(['"`])((?:\.{1,2}\/|@[a-z]+\/)[^'"`\s$]*)\1/g, (whole, q, spec) => {
    const alias = Object.keys(ALIASES).find((a) => spec.startsWith(a))
    const target = alias
      ? ALIASES[alias] + spec.slice(alias.length)
      : posix.normalize(posix.join(posix.dirname(file), spec))
    const ext = RESOLVE_EXTS.find((e) => oldPaths.has(target + e))
    if (ext === undefined) return whole
    const newBase = posix.basename(oldPaths.get(target + ext))
    return q + spec.replace(/[^/]+$/, newBase.slice(0, newBase.length - ext.length)) + q
  })
}

export function run({ dryRun = false } = {}) {
  const files = trackedFiles()
  const { renames, problems } = plan(files)
  if (problems.length) throw new Error(`refusing to rename:\n  ${problems.join('\n  ')}`)
  if (renames.length === 0) {
    console.log('naming convention: nothing to rename')
    return { renames, edited: [] }
  }

  const oldPaths = new Map(renames.map((r) => [r.from, r.to]))
  const stems = new Set(renames.map((r) => posix.basename(r.from).split('.')[0]))
  // A stem shared with an out-of-scope tracked file would rewrite mentions of that file too.
  for (const f of files) {
    const stem = posix.basename(f).split('.')[0]
    if (stems.has(stem) && !oldPaths.has(f) && CODE_EXT.test(f)) {
      console.warn(`naming convention: skipping mention rewrite for "${stem}" (also names ${f})`)
      stems.delete(stem)
    }
  }

  const edited = []
  for (const file of files) {
    if (SKIP_TEXT.test(file) || !existsSync(file)) continue
    const before = readFileSync(file)
    if (before.includes(0)) continue
    const isCode = CODE_EXT.test(file)
    let text = before.toString('utf8')
    if (isCode) text = rewriteSpecifiers(text, file, oldPaths)
    text = rewriteMentions(text, stems, isCode)
    if (text !== before.toString('utf8')) {
      edited.push(file)
      if (!dryRun) writeFileSync(file, text)
    }
  }

  for (const { from, to } of renames) {
    console.log(`${dryRun ? 'would rename' : 'rename'} ${from} -> ${to}`)
    if (dryRun) continue
    if (from.toLowerCase() === to.toLowerCase()) {
      // Case-only rename: a direct git mv is a no-op on case-insensitive filesystems.
      const tmp = `${from}.naming-tmp`
      git('mv', from, tmp)
      git('mv', tmp, to)
    } else {
      git('mv', from, to)
    }
  }
  // The full-tree check ships skipped so the tool can merge before the rename does.
  const testFile = 'tests/unit/file-naming-convention.test.ts'
  if (!dryRun && existsSync(testFile)) {
    const src = readFileSync(testFile, 'utf8')
    const unskipped = src.replace(/\n *\/\/ Unskipped by the generated rename commit\.\n( *)it\.skip\(/, '\n$1it(')
    if (unskipped !== src) {
      writeFileSync(testFile, unskipped)
      edited.push(testFile)
    }
  }
  for (const f of edited) console.log(`${dryRun ? 'would edit' : 'edited'} ${oldPaths.get(f) ?? f}`)
  if (!dryRun && edited.length) git('add', '--', ...edited.map((f) => oldPaths.get(f) ?? f))
  console.log(`naming convention: ${renames.length} renames, ${edited.length} files with rewritten references${dryRun ? ' (dry run)' : ''}`)
  return { renames, edited }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'))
  run({ dryRun: process.argv.includes('--dry-run') })
}
