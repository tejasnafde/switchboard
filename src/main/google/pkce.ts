/**
 * PKCE material for the desktop's Google flow.
 *
 * Separate from `src/shared/google-oauth.ts` because the phone imports that
 * module for the credential-blob contract, and React Native has no
 * `node:crypto`. Only the desktop mints, so only the desktop needs this.
 */
import { createHash, randomBytes } from 'node:crypto'

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** S256 of the verifier. Padding and `+`/`/` would survive into the query
 *  string and come back as a bare `invalid_grant`, so they are stripped. */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest())
}

export interface PkcePair {
  verifier: string
  challenge: string
}

/** 32 bytes is the upper end of RFC 7636's range; the verifier never leaves
 *  this process, so there is no reason to economise. */
export function pkcePair(): PkcePair {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: pkceChallenge(verifier) }
}

/** Opaque value tying the callback to this request. */
export function oauthState(): string {
  return b64url(randomBytes(16))
}
