import { describe, it, expect } from 'vitest'
import { friendlyUpdateError } from '../../src/main/updater-error'

describe('friendlyUpdateError', () => {
  it('maps offline / network errors to a clean message', () => {
    expect(friendlyUpdateError('net::ERR_INTERNET_DISCONNECTED')).toBe('No internet connection')
    expect(friendlyUpdateError('getaddrinfo ENOTFOUND github.com')).toBe('No internet connection')
    expect(friendlyUpdateError('request to https://… failed, reason: ETIMEDOUT')).toBe('No internet connection')
  })

  it('passes through non-network errors unchanged', () => {
    expect(friendlyUpdateError('HttpError: 404 Not Found')).toBe('HttpError: 404 Not Found')
    expect(friendlyUpdateError('signature verification failed')).toBe('signature verification failed')
  })
})
