/** summarizeSshError: pull the real cause out of noisy ssh/gcloud-IAP stderr. */
import { describe, it, expect } from 'vitest'
import { summarizeSshError } from '../../src/main/machines/sshError'

describe('summarizeSshError', () => {
  it('strips the gcloud IAP NumPy warning and surfaces the host-key cause (real captured stderr)', () => {
    const stderr = `WARNING:

To increase the performance of the tunnel, consider installing NumPy. For instructions,
please see https://cloud.google.com/iap/docs/using-tcp-forwarding#increasing_the_tcp_upload_bandwidth

Host key verification failed.`
    expect(summarizeSshError(stderr)).toBe('Host key verification failed.')
  })

  it('prefers a recognised cause over the last line', () => {
    expect(summarizeSshError('debug1: connecting\nPermission denied (publickey).')).toBe(
      'Permission denied (publickey).',
    )
  })

  it('falls back to the last non-noise line when no cause matches', () => {
    expect(summarizeSshError('WARNING: numpy thing\nsomething unexpected went wrong')).toBe(
      'something unexpected went wrong',
    )
  })

  it('returns empty for empty stderr', () => {
    expect(summarizeSshError('   \n  ')).toBe('')
  })

  it('does not surface the IAP bandwidth advisory as the cause of a killed tunnel (live-captured)', () => {
    // Real teardown stderr from a gcloud-IAP tunnel killed mid-session: the
    // advisory is the only non-empty content, and it is not a failure cause.
    const stderr = `To increase the performance of the tunnel, consider installing NumPy. For instructions,
please see https://cloud.google.com/iap/docs/using-tcp-forwarding#increasing_the_tcp_upload_bandwidth`
    expect(summarizeSshError(stderr)).not.toContain('cloud.google.com')
  })
})
