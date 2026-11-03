import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('iOS release CLI submission boundary', () => {
  // The workflow runs on Linux; its executable fixture uses a POSIX shebang.
  it.skipIf(process.platform === 'win32').each(['true', 'false'])(
    'restores config and keeps submit disabled in dry_run=%s',
    (dryRun) => {
      const root = mkdtempSync(join(tmpdir(), 'sb-ios-release-test-'))
      try {
        const bin = join(root, 'bin')
        mkdirSync(bin)
        const config = {
          build: { store: { distribution: 'store' } },
          submit: { store: { ios: { ascAppId: '6824965919', ascApiKeyPath: '$ASC_API_KEY_PATH' } } },
        }
        const original = JSON.stringify(config)
        writeFileSync(join(root, 'eas.json'), original)
        writeFileSync(
          join(root, 'app.json'),
          JSON.stringify({
            expo: {
              ios: { bundleIdentifier: 'app.tn07.switchboard' },
              extra: { eas: { projectId: 'efbb89d9-210f-4584-bf62-8186cd5fb476' } },
            },
          }),
        )
        writeFileSync(
          join(bin, 'eas'),
          `#!/usr/bin/env node
const fs = require('node:fs')
const command = process.argv[2]
fs.appendFileSync(process.env.CALLS, command + '\\n')
const config = JSON.parse(fs.readFileSync('eas.json'))
if (command.startsWith('submit')) {
  if (config.submit.store.ios.ascApiKeyPath !== '/private/fixture.p8') process.exit(5)
  if (command === 'submit') process.exit(7)
} else if (config.submit.store.ios.ascApiKeyPath !== '$ASC_API_KEY_PATH') process.exit(6)
console.log(JSON.stringify([{ id:'12345678-1234-1234-1234-123456789abc', status:'FINISHED', platform:'IOS', distribution:'STORE', buildProfile:'store', gitCommitHash:process.env.SOURCE_SHA, app:{id:'efbb89d9-210f-4584-bf62-8186cd5fb476'}, appIdentifier:'app.tn07.switchboard', isForIosSimulator:false }]))
`,
          { mode: 0o755 },
        )
        const calls = join(root, 'calls')
        const summary = join(root, 'summary')
        const result = spawnSync(process.execPath, [resolve('scripts/ios-release.mjs'), 'build', root], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
            CALLS: calls,
            GITHUB_REF: 'refs/heads/main',
            SOURCE_SHA: 'a'.repeat(40),
            DRY_RUN: dryRun,
            GITHUB_STEP_SUMMARY: summary,
            ASC_API_KEY_PATH: '/private/fixture.p8',
            ASC_API_KEY_ID: 'fixture-key',
            ASC_API_KEY_ISSUER_ID: 'fixture-issuer',
          },
        })
        expect(readFileSync(join(root, 'eas.json'), 'utf8')).toBe(original)
        expect(readFileSync(calls, 'utf8')).toBe(`submit:status\nbuild\n${dryRun === 'false' ? 'submit\n' : ''}`)
        expect(result.status).toBe(dryRun === 'true' ? 0 : 1)
        if (dryRun === 'true') expect(readFileSync(summary, 'utf8')).toContain('did not submit')
        else expect(result.stderr).toContain('EAS submit failed')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
