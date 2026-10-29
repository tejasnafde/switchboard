/**
 * Series colours for a chart, in order. A `var(--x)` entry is an app theme
 * variable. Live pages get the first `HTML_LIVE_CHART_COLORS` resolved as
 * `--sb-chart-1` onward, so a page and a ```chart block match.
 */
export const CHART_SERIES_COLORS: readonly string[] = [
  'var(--accent)',
  'var(--success)',
  'var(--warning)',
  '#a371f7',
  '#39c5cf',
  '#db61a2',
  'var(--error)',
  'var(--text-muted)',
]
