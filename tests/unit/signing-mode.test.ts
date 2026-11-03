import childProcess from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifySigningEnvironment } from '../../scripts/signing-mode.mjs'

describe('release signing mode', () => {
  it('keeps the supported unsigned path when no credentials are configured', () => {
    expect(classifySigningEnvironment('mac', {})).toEqual({ mode: 'unsigned', missing: [] })
    expect(classifySigningEnvironment('windows', {})).toEqual({ mode: 'unsigned', missing: [] })
  })

  it('enables signed and notarized macOS packaging only for a complete set', () => {
    expect(
      classifySigningEnvironment('mac', {
        CSC_LINK: 'certificate',
        CSC_KEY_PASSWORD: 'password',
        APPLE_TEAM_ID: 'TEAMID',
        APPLE_API_KEY_P8: 'private-key',
        APPLE_API_KEY_ID: 'KEYID',
        APPLE_API_ISSUER: 'issuer-uuid',
      }),
    ).toEqual({ mode: 'signed', missing: [] })
  })

  it('no longer accepts the Apple ID and app-specific password set for macOS', () => {
    expect(
      classifySigningEnvironment('mac', {
        CSC_LINK: 'certificate',
        CSC_KEY_PASSWORD: 'password',
        APPLE_ID: 'developer@example.test',
        APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
        APPLE_TEAM_ID: 'TEAMID',
      }),
    ).toEqual({
      mode: 'invalid',
      missing: ['APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    })
  })

  it('enables Windows Authenticode only for a complete set', () => {
    expect(
      classifySigningEnvironment('windows', {
        WIN_CSC_LINK: 'certificate',
        WIN_CSC_KEY_PASSWORD: 'password',
      }),
    ).toEqual({ mode: 'signed', missing: [] })
  })

  it('fails closed and reports names, never values, for partial configuration', () => {
    expect(
      classifySigningEnvironment('mac', {
        CSC_LINK: 'do-not-print-this',
        APPLE_API_KEY_ID: 'KEYID',
      }),
    ).toEqual({
      mode: 'invalid',
      missing: ['CSC_KEY_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY_P8', 'APPLE_API_ISSUER'],
    })
    expect(
      classifySigningEnvironment('windows', {
        WIN_CSC_KEY_PASSWORD: 'do-not-print-this',
      }),
    ).toEqual({ mode: 'invalid', missing: ['WIN_CSC_LINK'] })
  })

  it('keeps signing requirements in the production overlay', () => {
    const base = load(readFileSync('electron-builder.yml', 'utf8')) as Record<string, any>
    const signed = load(readFileSync('electron-builder.signed.yml', 'utf8')) as Record<string, any>

    expect(base.mac.identity).toBeNull()
    expect(base.mac.hardenedRuntime).toBe(false)
    expect(base.win.signAndEditExecutable).toBe(false)
    expect(signed).toMatchObject({
      extends: './electron-builder.yml',
      forceCodeSigning: true,
      afterSign: 'build/afterSign.js',
      mac: {
        identity: 'Developer ID Application',
        hardenedRuntime: true,
        notarize: true,
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.inherit.plist',
      },
      win: { signAndEditExecutable: true },
    })
  })

  it('pins local macOS distribution scripts to the unsigned path', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    for (const name of ['dist', 'dist:fast', 'dist:arm64', 'dist:x64', 'dist:mac', 'dist:publish']) {
      expect(pkg.scripts[name]).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder')
    }
  })

  it('keeps release packaging compatible with the macOS Bash 3.2 runner', () => {
    const workflow = readFileSync('.github/workflows/release-build.yml', 'utf8')

    expect(workflow).not.toContain('config=()')
    expect(workflow).not.toContain('${config[@]}')
    expect(workflow).toContain('npx electron-builder --config electron-builder.signed.yml --publish "$PUBLISH_MODE"')
    expect(workflow).toContain('npx electron-builder --publish "$PUBLISH_MODE"')
  })

  it('notarizes with the App Store Connect API key written to a file, never the raw key', () => {
    const workflow = readFileSync('.github/workflows/release-build.yml', 'utf8')
    const build = workflow.slice(workflow.indexOf('- name: Build & publish'))

    expect(workflow).not.toContain('APPLE_ID')
    expect(workflow).not.toContain('APPLE_APP_SPECIFIC_PASSWORD')
    expect(workflow).toContain('umask 077')
    expect(workflow).toContain('echo "APPLE_API_KEY=$key" >> "$GITHUB_ENV"')
    expect(build).toContain('APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}')
    expect(build).toContain('APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}')
    expect(build).not.toContain('APPLE_API_KEY_P8')
  })

  describe('afterSign on a signed macOS build', () => {
    const require = createRequire(import.meta.url)

    afterEach(() => {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
    })

    it('checks the signature with the update requirement, Gatekeeper and the ticket', async () => {
      const calls: string[][] = []
      vi.spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args: string[]) => {
        calls.push([file, ...args])
        return Buffer.alloc(0)
      }) as typeof childProcess.execFileSync)
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.stubEnv('SB_SIGNING_MODE', 'signed')
      const hookPath = require.resolve('../../build/afterSign.js')
      delete require.cache[hookPath]
      const { default: afterSign } = require(hookPath)

      await afterSign({
        electronPlatformName: 'darwin',
        appOutDir: '/out',
        packager: { appInfo: { productFilename: 'Switchboard', id: 'com.tejasnafde.switchboard' } },
      })

      const app = '/out/Switchboard.app'
      expect(calls).toEqual([
        [
          'codesign',
          '--verify',
          '--deep',
          '--strict',
          '--verbose=2',
          '-R=identifier "com.tejasnafde.switchboard"',
          app,
        ],
        ['spctl', '--assess', '--type', 'exec', '-vv', app],
        ['xcrun', 'stapler', 'validate', app],
      ])
    })
  })
})
