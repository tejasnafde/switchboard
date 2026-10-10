import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const artifactBuildCompleted = require('../../build/artifactBuildCompleted.js') as (
  event: Record<string, unknown>,
) => Promise<void> | void

describe('Desktop release compatibility gate', () => {
  it('declares the app bundle minimum as macOS 12', () => {
    const config = readFileSync(resolve('electron-builder.yml'), 'utf8')
    expect(config).toMatch(/minimumSystemVersion:\s*['"]12\.0['"]/)
  })

  it('fails release verification if the published macOS feed loses its Darwin floor', () => {
    const verify = readFileSync(resolve('scripts/verify-release-assets.sh'), 'utf8')
    expect(verify).toContain('^minimumSystemVersion: 21.0.0$')
  })

  it('creates one draft before the platform builds and exposes it only after the macOS assets verify', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    const prepareAt = workflow.indexOf('prepare_release:')
    const buildAt = workflow.indexOf('\n  build_mac:')
    const publishJob = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  verify_windows:'))

    expect(prepareAt).toBeGreaterThan(-1)
    expect(prepareAt).toBeLessThan(buildAt)
    expect(workflow).toContain('gh release create "$TAG" --repo "$REPO" --draft')
    expect(workflow).toContain('needs: prepare_release')
    expect(publishJob).toContain('needs: build_mac')
    expect(publishJob.indexOf('verify-release-assets.sh')).toBeGreaterThan(-1)
    expect(publishJob.indexOf('gh release edit "$TAG" --repo "$REPO" --draft=false --latest')).toBeGreaterThan(
      publishJob.indexOf('verify-release-assets.sh'),
    )
    expect(workflow).toMatch(
      /verify_windows:[\s\S]*needs: \[build_win, publish\][\s\S]*verify-release-assets\.sh[^\n]*win/,
    )
  })

  it('skips the release Gate only when main CI already passed on the same commit', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('actions/workflows/ci.yml/runs?head_sha=$SHA&status=success')
    expect(workflow).toContain("if: needs.ci_status.outputs.green != 'true'")
    expect(workflow).toContain("(needs.gate.result == 'success' || needs.gate.result == 'skipped')")
  })

  it('takes the version from the tag, so main needs no version-bump pull request', () => {
    const build = readFileSync(resolve('.github/workflows/release-build.yml'), 'utf8')
    expect(build).toContain('npm version "${GITHUB_REF_NAME#v}" --no-git-tag-version --allow-same-version')
    expect(build.indexOf('npm version')).toBeLessThan(build.indexOf('npm run build:ci'))
  })

  it('removes run-as-node from the Electron smoke-test environment', () => {
    const smokeTest = readFileSync(resolve('scripts/smoke-test.mjs'), 'utf8')
    expect(smokeTest).toContain('delete electronEnv.ELECTRON_RUN_AS_NODE')
    expect(smokeTest).not.toContain("ELECTRON_RUN_AS_NODE: ''")
  })

  it('writes the Darwin 21 kernel floor understood by v0.8.35 electron-updater', async () => {
    const event = {
      file: '/release/Switchboard-0.8.51-arm64-mac.zip',
      updateInfo: { sha512: 'precomputed-by-builder' },
      packager: { platform: { nodeName: 'darwin' } },
    }
    await artifactBuildCompleted(event)
    expect(event.updateInfo).toEqual({ minimumSystemVersion: '21.0.0' })
  })

  it('does not attach the macOS floor to Windows metadata', async () => {
    const event = {
      file: 'C:/release/Switchboard-Setup-0.8.51.exe',
      updateInfo: {},
      packager: { platform: { nodeName: 'win32' } },
    }
    await artifactBuildCompleted(event)
    expect(event.updateInfo).toEqual({})
  })
})
