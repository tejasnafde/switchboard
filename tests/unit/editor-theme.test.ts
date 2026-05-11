/**
 * Snapshot test for the GitHub-Dark / Light token tables. The visible
 * identity of the editor is a port of Shiki's github-dark theme — if a
 * token color drifts here, the editor's syntax highlight will look
 * different from the chat-bubble code blocks (which still render via
 * Shiki). The exported color tables are the regression net.
 */
import { describe, expect, it } from 'vitest'
import {
  GITHUB_DARK_TOKENS,
  GITHUB_LIGHT_TOKENS,
} from '../../src/renderer/components/files/editor/theme/tokenColors'

describe('GITHUB_DARK_TOKENS', () => {
  it('exposes the canonical dark-theme colors used by the highlight-style builder', () => {
    expect(GITHUB_DARK_TOKENS.keyword).toBe('#FF7B72')
    expect(GITHUB_DARK_TOKENS.string).toBe('#A5D6FF')
    expect(GITHUB_DARK_TOKENS.comment).toBe('#8B949E')
    expect(GITHUB_DARK_TOKENS.function).toBe('#D2A8FF')
    expect(GITHUB_DARK_TOKENS.type).toBe('#FFA657')
    expect(GITHUB_DARK_TOKENS.variable).toBe('#FFA657')
    expect(GITHUB_DARK_TOKENS.number).toBe('#79C0FF')
    expect(GITHUB_DARK_TOKENS.constant).toBe('#79C0FF')
    expect(GITHUB_DARK_TOKENS.property).toBe('#79C0FF')
    expect(GITHUB_DARK_TOKENS.heading).toBe('#79C0FF')
  })
})

describe('GITHUB_LIGHT_TOKENS', () => {
  it('exposes the canonical light-theme colors', () => {
    expect(GITHUB_LIGHT_TOKENS.keyword).toBe('#CF222E')
    expect(GITHUB_LIGHT_TOKENS.string).toBe('#0A3069')
    expect(GITHUB_LIGHT_TOKENS.comment).toBe('#6E7781')
    expect(GITHUB_LIGHT_TOKENS.function).toBe('#8250DF')
    expect(GITHUB_LIGHT_TOKENS.type).toBe('#953800')
    expect(GITHUB_LIGHT_TOKENS.variable).toBe('#953800')
    expect(GITHUB_LIGHT_TOKENS.number).toBe('#0550AE')
    expect(GITHUB_LIGHT_TOKENS.constant).toBe('#0550AE')
    expect(GITHUB_LIGHT_TOKENS.property).toBe('#0550AE')
    expect(GITHUB_LIGHT_TOKENS.heading).toBe('#0550AE')
  })
})
