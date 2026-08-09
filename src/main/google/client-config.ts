/**
 * Where the desktop's Google OAuth client comes from. Environment first, then
 * saved settings; no bundled default.
 *
 * The secret sits in plain settings deliberately: a Desktop-type client secret
 * ships inside installed apps by design and is not a trust boundary, PKCE is.
 * The refresh token this mints IS the real credential and is never stored here.
 */
import { getSetting, setSetting } from '../db/database'
import {
  resolveClientConfig,
  type ClientConfig,
  type PartialClientConfig,
} from '@shared/google-oauth'

const SETTING_CLIENT_ID = 'google.clientId'
const SETTING_CLIENT_SECRET = 'google.clientSecret'

export type ClientSource = 'env' | 'settings' | 'none'

export interface GoogleClientStatus {
  configured: boolean
  source: ClientSource
  /** Not sensitive - it appears in every auth URL. */
  clientId?: string
}

function fromEnv(): PartialClientConfig {
  return {
    clientId: process.env.SWITCHBOARD_GOOGLE_CLIENT_ID,
    clientSecret: process.env.SWITCHBOARD_GOOGLE_CLIENT_SECRET,
  }
}

function fromSettings(): PartialClientConfig {
  return {
    clientId: getSetting(SETTING_CLIENT_ID) ?? undefined,
    clientSecret: getSetting(SETTING_CLIENT_SECRET) ?? undefined,
  }
}

export function currentGoogleClient(): ClientConfig | null {
  return resolveClientConfig({ env: fromEnv(), settings: fromSettings() })
}

export function googleClientStatus(): GoogleClientStatus {
  const client = currentGoogleClient()
  if (!client) return { configured: false, source: 'none' }
  const envClient = resolveClientConfig({ env: fromEnv(), settings: {} })
  return {
    configured: true,
    source: envClient ? 'env' : 'settings',
    clientId: client.clientId,
  }
}

/** An ABSENT field leaves the stored value alone; only an explicit empty
 *  string clears it. The secret field renders blank on reopen, so writing
 *  unconditionally blanked a working secret. */
export function setGoogleClient(config: PartialClientConfig): GoogleClientStatus {
  if (config.clientId !== undefined) setSetting(SETTING_CLIENT_ID, config.clientId.trim())
  if (config.clientSecret !== undefined) {
    setSetting(SETTING_CLIENT_SECRET, config.clientSecret.trim())
  }
  return googleClientStatus()
}
