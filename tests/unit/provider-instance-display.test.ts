/**
 * Pure helpers backing ProvidersTab.tsx's credential-home display and
 * new-instance defaults. Extracted so they're unit-testable without
 * mounting the (untested, .tsx) settings dialog - this project's vitest
 * config runs `.test.ts` files under the `node` environment only.
 *
 * Requirements pinned here (behavior: accurate effective-home display):
 *  - the display must be driven by `effectiveOauthDirSource`, the
 *    backend-authoritative field, not by the raw `oauthDir` column - a
 *    legacy env-overlay row has no `oauthDir` at all but is still isolated.
 *  - 'oauth_dir'   -> the normal, isolated per-instance path, no warning.
 *  - 'env'         -> isolated too, but labeled as a legacy env-overlay home
 *                     so the user understands why there is no oauth_dir set.
 *  - 'default'     -> the shared canonical home, with an explicit isolation
 *                     warning - this is the ambient-risk case.
 *  - 'unresolved'  -> "cannot verify" rather than guessing a directory that
 *                     might be wrong (only the encrypted overlay could say).
 *  - never an account identity (no email/user parsing) and never a secret
 *    (env values never flow into this display at all).
 *  - new Codex instances default to oauth_dir mode; other kinds keep 'env'.
 */
import { describe, it, expect } from 'vitest'
import {
  credentialHomeDisplay,
  defaultAuthModeForNewInstance,
} from '../../src/renderer/shared/providerInstanceDisplay'

describe('credentialHomeDisplay', () => {
  it('shows the explicit oauth_dir as a plain isolated path, no warning', () => {
    const d = credentialHomeDisplay('/Users/tejas/.codex-work', 'oauth_dir')
    expect(d).toMatchObject({ text: '/Users/tejas/.codex-work', isolated: true, warning: null })
  })

  it('labels a legacy env-overlay home as such, and still isolated', () => {
    const d = credentialHomeDisplay('/Users/tejas/.codex-legacy', 'env')
    expect(d.isolated).toBe(true)
    expect(d.warning).toBeNull()
    expect(d.text).toContain('/Users/tejas/.codex-legacy')
    expect(d.text.toLowerCase()).toContain('legacy')
  })

  it('flags the canonical default as shared/ambient with an isolation warning', () => {
    const d = credentialHomeDisplay('/Users/tejas/.codex', 'default')
    expect(d.isolated).toBe(false)
    expect(d.text).toContain('/Users/tejas/.codex')
    expect(d.warning).toBeTruthy()
    expect(d.warning!.toLowerCase()).toContain('shared')
  })

  it('shows "cannot verify" for an unresolved row instead of guessing a path', () => {
    const d = credentialHomeDisplay(null, 'unresolved')
    expect(d.text.toLowerCase()).toContain('cannot verify')
    expect(d.isolated).toBe(false)
    // No directory anywhere in the text - nothing here may look like a path.
    expect(d.text).not.toMatch(/[\\/]/)
  })

  it('never emits anything but the path and a label - no env values, no identity', () => {
    const d = credentialHomeDisplay('/Users/tejas/.claude-work', 'oauth_dir')
    expect(d.text).not.toMatch(/@/) // no email-shaped identity ever
  })
})

describe('defaultAuthModeForNewInstance', () => {
  it('defaults new codex instances to oauth_dir', () => {
    expect(defaultAuthModeForNewInstance('codex')).toBe('oauth_dir')
  })

  it('defaults new claude-code instances to env (unchanged)', () => {
    expect(defaultAuthModeForNewInstance('claude-code')).toBe('env')
  })

  it('defaults new opencode instances to env (no oauth concept)', () => {
    expect(defaultAuthModeForNewInstance('opencode')).toBe('env')
  })
})
