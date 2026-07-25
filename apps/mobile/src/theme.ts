/** Charcoal palette matching the desktop's dark theme. */
export const colors = {
  bg: '#0d0f12',
  surface: '#16191e',
  surfaceRaised: '#1e2228',
  border: '#2a2f37',
  text: '#e8eaed',
  textDim: '#9aa0a8',
  textFaint: '#6b7178',
  accent: '#4f8ef7',
  green: '#34c77b',
  amber: '#e5a53a',
  red: '#e5544a',
  purple: '#a175f5',
} as const

export const statusColor: Record<string, string> = {
  connected: colors.green,
  connecting: colors.amber,
  running: colors.accent,
  idle: colors.green,
  error: colors.red,
  disconnected: colors.textFaint,
  stopped: colors.textFaint,
}
