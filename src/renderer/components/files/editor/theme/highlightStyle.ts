/**
 * Build a CM6 HighlightStyle + EditorView theme from a TokenColors map.
 * The chrome (gutter bg, cursor color, selection color, etc.) is driven
 * by our existing CSS custom-properties so dark/light/translucent themes
 * inherit automatically from `theme-store`.
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import {
  GITHUB_DARK_TOKENS,
  GITHUB_LIGHT_TOKENS,
  type TokenColors,
} from './tokenColors'

function buildHighlightStyle(c: TokenColors): HighlightStyle {
  return HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: c.keyword },
    { tag: [t.string, t.special(t.string), t.regexp], color: c.string },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c.comment, fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.function },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: c.type },
    { tag: [t.variableName, t.definition(t.variableName)], color: c.variable },
    { tag: [t.number, t.integer, t.float], color: c.number },
    { tag: [t.bool, t.null, t.atom, t.literal], color: c.constant },
    { tag: [t.propertyName], color: c.property },
    { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: c.heading, fontWeight: 'bold' },
    { tag: t.link, color: c.string, textDecoration: 'underline' },
    { tag: t.invalid, color: '#f85149' },
  ])
}

/**
 * Editor-chrome theme — inherits CSS custom properties from theme-store
 * so dark / light / translucent all flow through without rebuilding.
 */
const chromeTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--text-primary)',
    height: '100%',
    fontSize: '12px',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    caretColor: 'var(--text-primary)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--accent-subtle, rgba(56,139,253,0.15))',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--bg-secondary)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-secondary)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 6px' },
  '.cm-panels': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' },
  '.cm-panels .cm-textfield': {
    backgroundColor: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
  },
  '.cm-searchMatch': { backgroundColor: 'rgba(255, 211, 0, 0.25)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 211, 0, 0.45)' },
})

export function darkTheme(): Extension[] {
  return [chromeTheme, syntaxHighlighting(buildHighlightStyle(GITHUB_DARK_TOKENS))]
}

export function lightTheme(): Extension[] {
  return [chromeTheme, syntaxHighlighting(buildHighlightStyle(GITHUB_LIGHT_TOKENS))]
}

export function themeFor(name: 'dark' | 'light' | 'translucent'): Extension[] {
  // Translucent inherits the dark token palette — same CSS-vars-driven
  // chrome already handles the vibrancy backdrop.
  return name === 'light' ? lightTheme() : darkTheme()
}
