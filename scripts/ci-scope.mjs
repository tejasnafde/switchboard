#!/usr/bin/env node
// Decides which CI jobs a pull request needs, from the files it changes.
//
// Reads changed paths (one per line) on stdin and prints `code=` and `visual=`
// lines for $GITHUB_OUTPUT. The rule is a deny-list of files no test or build
// reads: anything not on it runs the whole suite, so a new kind of file costs a
// CI run rather than slipping past one. Root unit tests read workflow files and
// Android sources, which is why neither is on the list.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const NON_CODE = [
  /\.md$/,
  /^docs\//,
  /^LICENSE$/,
  /^\.editorconfig$/,
  /^\.coderabbit\.yaml$/,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/dependabot\.yml$/,
]

// Paths the screenshot job can see a change from. Everything else in a code
// change (Android, mobile, scripts) cannot move a desktop pixel.
const VISUAL = [
  /^src\//,
  /^e2e\//,
  /^resources\//,
  /^build\//,
  /^package(-lock)?\.json$/,
  /^electron\.vite\.config\.ts$/,
  /^\.github\/workflows\/ci\.yml$/,
]

export function ciScope(paths) {
  const code = paths.filter((p) => !NON_CODE.some((re) => re.test(p)))
  return {
    code: code.length > 0,
    visual: code.some((p) => VISUAL.some((re) => re.test(p))),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = readFileSync(0, 'utf8').split('\n').map((p) => p.trim()).filter(Boolean)
  // No diff to read (an empty or unreadable range) must not skip anything.
  const scope = paths.length === 0 ? { code: true, visual: true } : ciScope(paths)
  process.stdout.write(`code=${scope.code}\nvisual=${scope.visual}\n`)
}
