/**
 * Design tokens for the mobile app.
 *
 * The look belongs to the same family as desktop Switchboard: near-black
 * neutrals, hairline translucent borders, one cool-blue accent spent sparingly,
 * status carried by small colour dots rather than chrome. Touch-adapted rather
 * than shrunk - larger targets and a slower vertical rhythm than the desktop's
 * dense panels.
 *
 * Colours are aligned to src/renderer/styles/global.css. They had drifted: the
 * mobile background was blue-tinted (#0d0f12 vs #0a0a0a) and the accent was a
 * different blue (#4f8ef7 vs #58a6ff), which is a large part of why the app read
 * as a different product rather than Switchboard on a phone.
 *
 * Typography pairs a display grotesque with a technical mono, deliberately not
 * the same family: Instrument Sans carries headings and titles, Geist Mono
 * carries anything the machine produced (paths, ids, tokens, model names, code).
 * Body copy stays on the platform face, which is what a phone should read like.
 */

export const colors = {
  /** App background. Neutral black, matching --bg-primary. */
  bg: '#0a0a0a',
  /** Cards, headers, composer. --bg-surface. */
  surface: '#141414',
  /** Raised chips and inputs sitting on a surface. --bg-elevated. */
  surfaceRaised: '#1c1c1c',
  /** Pressed / selected wash, translucent so it works over either. */
  wash: 'rgba(255,255,255,0.05)',
  /** Accent wash for selected state. --bg-active. */
  accentWash: 'rgba(88,166,255,0.10)',

  /** Hairline, translucent rather than a solid grey line. --border. */
  border: 'rgba(255,255,255,0.07)',
  borderStrong: 'rgba(255,255,255,0.14)',

  text: '#e2e8f0',
  textDim: '#8b949e',
  textFaint: '#484f58',

  accent: '#58a6ff',
  green: '#3fb950',
  amber: '#d29922',
  red: '#f85149',
  purple: '#bc8cff',
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

/**
 * Font family names as registered with expo-font in App.tsx. Referenced through
 * these constants so a swap is one edit, and so a typo surfaces at the type
 * level instead of silently falling back to the system face.
 */
export const fonts = {
  display: 'InstrumentSans_600SemiBold',
  displayBold: 'InstrumentSans_700Bold',
  mono: 'GeistMono_400Regular',
  monoMedium: 'GeistMono_500Medium',
} as const

/**
 * Type scale. Deliberately more contrast than a timid ramp: titles are large
 * enough to anchor a screen, metadata small enough to recede without being
 * unreadable. Line heights are generous because most of this app is reading.
 */
export const type = {
  /** Screen-owning title, display face. */
  title: { fontFamily: fonts.displayBold, fontSize: 26, lineHeight: 31 },
  /** Card / row heading. */
  heading: { fontFamily: fonts.display, fontSize: 16, lineHeight: 21 },
  /** Section label above a group, small and quiet. */
  label: { fontFamily: fonts.display, fontSize: 11, lineHeight: 14, letterSpacing: 0.7 },
  /** Body copy and chat messages: platform face, most legible at length. */
  body: { fontSize: 15, lineHeight: 23 },
  bodySm: { fontSize: 13, lineHeight: 20 },
  /** Machine-produced text: paths, ids, tokens, model names. */
  mono: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
  monoSm: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 16 },
} as const

/** 4pt rhythm. Use these rather than ad-hoc numbers so screens agree. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 36,
} as const

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const

/** Minimum comfortable touch target. Rows and buttons should not go below this. */
export const HIT = 44
