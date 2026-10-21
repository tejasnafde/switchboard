/**
 * One line of context the backend puts in front of a user's turn: which
 * surface sent it, from which device, which machine runs the agent, and
 * whether a localhost URL on that machine reaches the user.
 *
 * The backend builds it from the authenticated connection, never from the
 * turn, and only the provider gets it. The stored message never holds it, and
 * the transcript parser strips it on reload (`stripSenderLine`), so no client
 * shows it.
 */

export const SENDER_LINE_OPEN = '<switchboard-sender>'
export const SENDER_LINE_CLOSE = '</switchboard-sender>'

/** The whole line, tags included, stays at or under this. */
export const SENDER_LINE_MAX_CHARS = 200

export type SenderSurface = 'desktop' | 'ios' | 'android' | 'other'

export interface SenderContext {
  surface: SenderSurface
  /** The device's name, for a paired phone. */
  deviceName?: string
  /** The device's model, for a paired phone. */
  deviceKind?: string
  /** Absent when the agent runs on the user's own computer. */
  sshMachine?: string
  localhostReachesUser: boolean
}

const SURFACE_LABEL: Record<SenderSurface, string> = {
  desktop: 'desktop app',
  ios: 'iOS app',
  android: 'Android app',
  other: 'another client',
}

const DEVICE_FIELD_MAX = 20
const MACHINE_NAME_MAX = 30

/** Free text from a device or a host name, made safe for one line inside the tags. */
function clean(value: string | undefined, max: number): string {
  if (!value) return ''
  return value
    .replace(/[\p{Cc}<>"]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
}

export function formatSenderLine(ctx: SenderContext): string {
  const kind = clean(ctx.deviceKind, DEVICE_FIELD_MAX)
  const name = clean(ctx.deviceName, DEVICE_FIELD_MAX)
  const device = [kind, name && name !== kind ? `"${name}"` : ''].filter(Boolean).join(' ')
  const from = `From: ${SURFACE_LABEL[ctx.surface]}${device ? `, ${device}` : ''}.`
  const machine = clean(ctx.sshMachine, MACHINE_NAME_MAX)
  const host = machine ? `Agent host: SSH machine ${machine}.` : "Agent host: the user's computer."
  const localhost = ctx.localhostReachesUser
    ? 'Its localhost reaches the user.'
    : 'Its localhost does not reach the user.'
  return `${SENDER_LINE_OPEN}${from} ${host} ${localhost}${SENDER_LINE_CLOSE}`
}

/** A slash command must stay first in the prompt, or the agent does not run it. */
export function takesSenderLine(text: string): boolean {
  return !text.trimStart().startsWith('/')
}

export function withSenderLine(text: string, line: string): string {
  return `${line}\n\n${text}`
}

/** `text` without any sender line at its start (a client may send its own). */
export function stripSenderLine(text: string): string {
  let rest = text
  while (rest.startsWith(SENDER_LINE_OPEN)) {
    const end = rest.indexOf(SENDER_LINE_CLOSE)
    if (end < 0) return rest
    rest = rest.slice(end + SENDER_LINE_CLOSE.length).replace(/^\n+/, '')
  }
  return rest
}
