import childProcess from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
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
        notarize: false,
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

    const context = {
      electronPlatformName: 'darwin',
      appOutDir: '/out',
      packager: { appInfo: { productFilename: 'Switchboard', id: 'com.tejasnafde.switchboard' } },
    }

    function loadHook(stapleFailures: number) {
      const calls: string[][] = []
      let failures = stapleFailures
      vi.spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args: string[]) => {
        calls.push([file, ...args])
        if (args[0] === 'notarytool') return JSON.stringify({ id: 'sub-1', status: 'Accepted' })
        if (args[0] === 'stapler' && args[1] === 'staple' && failures > 0) {
          failures--
          throw new Error('Failed to staple your application with code: 68')
        }
        return Buffer.alloc(0)
      }) as typeof childProcess.execFileSync)
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubEnv('SB_SIGNING_MODE', 'signed')
      vi.stubEnv('APPLE_API_KEY', '/keys/AuthKey_KEYID.p8')
      vi.stubEnv('APPLE_API_KEY_ID', 'KEYID')
      vi.stubEnv('APPLE_API_ISSUER', 'issuer-uuid')
      const hookPath = require.resolve('../../build/afterSign.js')
      delete require.cache[hookPath]
      const hook = require(hookPath)
      hook.stapleRetryDelayMs = 0
      return { calls, afterSign: hook.default, hook }
    }

    it('notarizes, staples, then checks the update requirement and Gatekeeper', async () => {
      const { calls, afterSign } = loadHook(0)

      await afterSign(context)

      const app = path.join('/out', 'Switchboard.app')
      const zip = calls[0].at(-1)
      expect(zip).toMatch(/Switchboard\.zip$/)
      const submit = calls.find((call) => call[1] === 'notarytool')
      expect(submit?.slice(0, 4)).toEqual(['xcrun', 'notarytool', 'submit', zip])
      expect(submit).toEqual(
        expect.arrayContaining([
          'submit',
          '--key',
          '/keys/AuthKey_KEYID.p8',
          '--key-id',
          'KEYID',
          '--issuer',
          'issuer-uuid',
          '--wait',
        ]),
      )
      expect(calls.map((call) => call.slice(0, 2).join(' '))).toEqual([
        'ditto -c',
        'xcrun notarytool',
        'xcrun stapler',
        'codesign --verify',
        'spctl --assess',
      ])
      expect(calls.slice(2)).toEqual([
        ['xcrun', 'stapler', 'staple', '-v', app],
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
      ])
    })

    it('retries a failed staple and gives up after five attempts', async () => {
      const recovered = loadHook(2)
      await recovered.afterSign(context)
      expect(recovered.calls.filter((call) => call[2] === 'staple')).toHaveLength(3)

      vi.restoreAllMocks()
      const stuck = loadHook(5)
      await expect(stuck.afterSign(context)).rejects.toThrow('code: 68')
      expect(stuck.calls.filter((call) => call[2] === 'staple')).toHaveLength(5)
      expect(stuck.calls.some((call) => call[0] === 'codesign')).toBe(false)
    })

    it('waits longer before each staple retry', async () => {
      const { afterSign, hook } = loadHook(4)
      hook.stapleRetryDelayMs = 30_000
      const delays: number[] = []
      const realSetTimeout = setTimeout
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
        delays.push(ms)
        return realSetTimeout(fn, 0)
      }) as typeof setTimeout)

      await afterSign(context)

      expect(delays).toEqual([30_000, 60_000, 90_000, 120_000])
    })

    it('refuses to run without signed mode', async () => {
      const { afterSign } = loadHook(0)
      vi.stubEnv('SB_SIGNING_MODE', '')

      await expect(afterSign(context)).rejects.toThrow('needs SB_SIGNING_MODE=signed')
    })

    it('fails when Apple does not accept the submission', async () => {
      const { afterSign } = loadHook(0)
      vi.mocked(childProcess.execFileSync).mockImplementation(((_file: string, args: string[]) =>
        args[0] === 'notarytool'
          ? JSON.stringify({ id: 'sub-2', status: 'Invalid' })
          : Buffer.alloc(0)) as typeof childProcess.execFileSync)

      await expect(afterSign(context)).rejects.toThrow('sub-2 ended with status Invalid')
    })
  })
})
