/**
 * The text colour for initials on an accent fill: black or white, whichever
 * reads better. Instance accents are bright (#ffd23d, #3dd17a), and white
 * initials on them fell to 1.4:1. A fill that is not #rrggbb gets white.
 */
export function initialsInk(fill: string): '#000' | '#fff' {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fill.trim())
  if (!match) return '#fff'
  const [r, g, b] = match.slice(1).map((part) => {
    const c = parseInt(part, 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  // White wins while (1.05) / (L + 0.05) beats (L + 0.05) / 0.05.
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.05 ? '#fff' : '#000'
}
