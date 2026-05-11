/**
 * Canonical syntax-token colors ported from Shiki's `github-dark` and
 * `github-light` themes. Exported as plain objects so the highlight-style
 * builder pulls from a single source and a unit-test snapshot detects
 * drift if anyone tweaks them in isolation.
 *
 * Token keys follow CM6 / Lezer highlight-tag families, NOT TextMate
 * scopes — we map TextMate → tag at this seam (e.g. Shiki's
 * `entity.name.function` becomes `function` here, then bound to
 * `tags.function(tags.variableName)` in `highlightStyle.ts`).
 */
export interface TokenColors {
  keyword: string
  string: string
  comment: string
  function: string
  type: string
  variable: string
  number: string
  constant: string
  property: string
  heading: string
}

export const GITHUB_DARK_TOKENS: Readonly<TokenColors> = {
  keyword:  '#FF7B72',
  string:   '#A5D6FF',
  comment:  '#8B949E',
  function: '#D2A8FF',
  type:     '#FFA657',
  variable: '#FFA657',
  number:   '#79C0FF',
  constant: '#79C0FF',
  property: '#79C0FF',
  heading:  '#79C0FF',
}

export const GITHUB_LIGHT_TOKENS: Readonly<TokenColors> = {
  keyword:  '#CF222E',
  string:   '#0A3069',
  comment:  '#6E7781',
  function: '#8250DF',
  type:     '#953800',
  variable: '#953800',
  number:   '#0550AE',
  constant: '#0550AE',
  property: '#0550AE',
  heading:  '#0550AE',
}
