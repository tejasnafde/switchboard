import type { DiagramTheme } from '../components/chat/visuals/diagram-render'

/** The app theme a diagram draws in, read from <html>. */
export function diagramTheme(): DiagramTheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string): string => css.getPropertyValue(name).trim()
  return {
    dark: !document.documentElement.classList.contains('theme-light'),
    surface: v('--bg-tertiary'),
    text: v('--text-primary'),
    line: v('--text-secondary'),
    border: v('--text-muted'),
    font: v('--font-sans'),
  }
}
