import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { classifySigningEnvironment } from '../../scripts/signing-mode.mjs'

describe('release signing mode', () => {
  it('keeps the supported unsigned path when no credentials are configured', () => {
    expect(classifySigningEnvironment('mac', {})).toEqual({ mode: 'unsigned', missing: [] })
    expect(classifySigningEnvironment('windows', {})).toEqual({ mode: 'unsigned', missing: [] })
  })

  it('enables signed and notarized macOS packaging only for a complete set', () => {
    expect(classifySigningEnvironment('mac', {
      CSC_LINK: 'certificate',
      CSC_KEY_PASSWORD: 'password',
      APPLE_ID: 'developer@example.test',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
      APPLE_TEAM_ID: 'TEAMID',
    })).toEqual({ mode: 'signed', missing: [] })
  })

  it('enables Windows Authenticode only for a complete set', () => {
    expect(classifySigningEnvironment('windows', {
      WIN_CSC_LINK: 'certificate',
      WIN_CSC_KEY_PASSWORD: 'password',
    })).toEqual({ mode: 'signed', missing: [] })
  })

  it('fails closed and reports names, never values, for partial configuration', () => {
    expect(classifySigningEnvironment('mac', {
      CSC_LINK: 'do-not-print-this',
      APPLE_ID: 'developer@example.test',
    })).toEqual({
      mode: 'invalid',
      missing: ['CSC_KEY_PASSWORD', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    })
    expect(classifySigningEnvironment('windows', {
      WIN_CSC_KEY_PASSWORD: 'do-not-print-this',
    })).toEqual({ mode: 'invalid', missing: ['WIN_CSC_LINK'] })
  })

  it('keeps signing requirements in the production overlay', () => {
    const base = load(readFileSync('electron-builder.yml', 'utf8')) as Record<string, any>
    const signed = load(readFileSync('electron-builder.signed.yml', 'utf8')) as Record<string, any>

    expect(base.mac.identity).toBeUndefined()
    expect(base.mac.hardenedRuntime).toBe(false)
    expect(base.win.signAndEditExecutable).toBe(false)
    expect(signed).toMatchObject({
      extends: './electron-builder.yml',
      forceCodeSigning: true,
      afterSign: 'build/afterSign.js',
      mac: {
        hardenedRuntime: true,
        notarize: true,
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.inherit.plist',
      },
      win: { signAndEditExecutable: true },
    })
  })
})
