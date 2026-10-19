/**
 * What a paired phone says about itself on every `auth` frame, so the
 * desktop can tell two phones apart and recognise a reinstall.
 *
 * `installId` is a UUID the app mints once per install and keeps. It is not a
 * credential: it only lets a NEW pairing (which already needs the one-time QR
 * code) replace the session an earlier pairing of the same install left
 * behind. Every other field is display text.
 *
 * A backend that predates this drops the field: `decodeFrame` there rebuilds
 * the auth frame from the keys it knows. So phones send it on every auth, even
 * before they have seen `device_identity_v1` (capabilities arrive in `ready`,
 * which only follows a successful auth).
 */

/** Advertised in `ready.capabilities` by a backend that records the identity
 *  and supersedes a re-paired install's old session. */
export const DEVICE_IDENTITY_CAPABILITY = 'device_identity_v1'

export type DevicePlatform = 'android' | 'ios'

export interface DeviceIdentity {
  installId: string
  /** The device's user-visible name where the OS exposes it, else the model. */
  name?: string
  manufacturer?: string
  model?: string
  platform?: DevicePlatform
  osVersion?: string
  appVersion?: string
}

/** Display fields are free text from the device; bounded so a hostile client
 *  cannot grow the settings row without limit. */
const MAX_FIELD_LENGTH = 128
const INSTALL_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_FIELD_LENGTH) : undefined
}

/** Null for anything without a usable installId; unknown or malformed
 *  display fields are dropped rather than failing the whole identity. */
export function parseDeviceIdentity(raw: unknown): DeviceIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.installId !== 'string' || !INSTALL_ID_PATTERN.test(value.installId)) return null
  const identity: DeviceIdentity = { installId: value.installId }
  const name = text(value.name)
  const manufacturer = text(value.manufacturer)
  const model = text(value.model)
  const osVersion = text(value.osVersion)
  const appVersion = text(value.appVersion)
  if (name) identity.name = name
  if (manufacturer) identity.manufacturer = manufacturer
  if (model) identity.model = model
  if (value.platform === 'android' || value.platform === 'ios') identity.platform = value.platform
  if (osVersion) identity.osVersion = osVersion
  if (appVersion) identity.appVersion = appVersion
  return identity
}
