import { describe, expect, it } from 'vitest'
import {
  googleClientUpdate,
  googleMintActionClass,
} from '../../src/renderer/components/settings/googleMintPresentation'

describe('Google mint panel presentation', () => {
  it('keeps the stored secret when the editor secret is blank', () => {
    expect(googleClientUpdate('client-id', '')).toEqual({ clientId: 'client-id' })
  })

  it('includes a newly entered secret', () => {
    expect(googleClientUpdate('client-id', 'new-secret')).toEqual({
      clientId: 'client-id',
      clientSecret: 'new-secret',
    })
  })

  it('uses consistent polished action classes for primary and secondary actions', () => {
    expect(googleMintActionClass('primary')).toBe(
      'google-mint-action google-mint-action--primary',
    )
    expect(googleMintActionClass('secondary')).toBe(
      'google-mint-action google-mint-action--secondary',
    )
  })
})
