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
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('^minimumSystemVersion: 21.0.0$')
  })

  it('creates one draft before parallel publishers and exposes it only after verification', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    const prepareAt = workflow.indexOf('prepare_release:')
    const buildAt = workflow.indexOf('\n  build:')
    const verifyAt = workflow.indexOf('\n  verify:')

    expect(prepareAt).toBeGreaterThan(-1)
    expect(prepareAt).toBeLessThan(buildAt)
    expect(workflow).toContain('gh release create "$TAG" --repo "$REPO" --draft')
    expect(workflow).toContain('needs: prepare_release')
    expect(workflow).toContain('gh release edit "$TAG" --repo "$REPO" --draft=false --latest')
    expect(workflow.indexOf('gh release edit "$TAG" --repo "$REPO" --draft=false --latest')).toBeGreaterThan(verifyAt)
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
