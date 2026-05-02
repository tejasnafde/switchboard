#!/usr/bin/env node
// Installs Switchboard's git hooks into .git/hooks/. Runs automatically on
// `npm install` via the `prepare` lifecycle.
//
// We copy (not symlink) so the hook works on Windows too, and so accidental
// edits to .git/hooks/pre-commit don't silently propagate back to the repo.
//
// Idempotent: re-installing overwrites with the latest scripts/pre-commit.sh.

import { copyFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const gitDir = resolve(repoRoot, '.git')

// Skip silently when not inside a git checkout (e.g. installed as a tarball
// dependency). `npm install` in CI can also run with the repo already
// configured — be tolerant.
if (!existsSync(gitDir)) {
  process.exit(0)
}

const hooksDir = resolve(gitDir, 'hooks')
if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true })

const src = resolve(here, 'pre-commit.sh')
const dst = resolve(hooksDir, 'pre-commit')

if (!existsSync(src)) {
  console.error(`[install-hooks] missing source hook: ${src}`)
  process.exit(1)
}

copyFileSync(src, dst)
chmodSync(dst, 0o755)
console.log(`[install-hooks] pre-commit installed -> ${dst}`)
